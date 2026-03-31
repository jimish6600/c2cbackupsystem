require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const GITLAB_URL = (process.env.GITLAB_URL || 'https://gitlab.com').replace(/\/$/, '');
const PROJECT_ID = encodeURIComponent(process.env.GITLAB_PROJECT_ID);
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';

const api = axios.create({
    baseURL: `${GITLAB_URL}/api/v4`,
    headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN },
});

function gitlabError(err) {
    const d = err.response?.data;
    const msg = d?.message || d?.error_description || d?.error || (typeof d === 'string' ? d : null);
    if (msg) console.error('GitLab error detail:', msg);
    return msg || err.message || 'Internal server error';
}

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
}

function getBranchName(company_id) {
    return company_id;
}

// Determine file extension based on key name
function getFileExtension(key) {
    if (key.includes('css')) return '.css';
    if (key.includes('script') || key.includes('js')) return '.js';
    return '.html';
}

// Flatten payload into file list
// Handles: top-level strings, top-level objects (nested templates)
// Keys starting with published_/unpublished_ are grouped into published/ or unpublished/ subfolder
function buildFileList(payload) {
    const files = [];
    const SKIP_KEYS = ['company_id'];

    for (const [key, value] of Object.entries(payload)) {
        if (SKIP_KEYS.includes(key)) continue;

        // Detect published/unpublished prefix and strip it from the file name
        let folder = null;
        let strippedKey = key;
        if (key.startsWith('published_')) {
            folder = 'published';
            strippedKey = key.slice('published_'.length);
        } else if (key.startsWith('unpublished_')) {
            folder = 'unpublished';
            strippedKey = key.slice('unpublished_'.length);
        }

        if (typeof value === 'string') {
            // e.g. published_c2c_css → published/c2c_css.css
            const ext = getFileExtension(key);
            const filePath = folder
                ? `${folder}/${strippedKey}${ext}`
                : `${key}${ext}`;
            files.push({ path: filePath, content: value });

        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            // e.g. published_c2c_template.product_listing → published/c2c_template/product_listing.html
            for (const [subKey, subValue] of Object.entries(value)) {
                if (typeof subValue === 'string') {
                    const ext = getFileExtension(subKey);
                    const filePath = folder
                        ? `${folder}/${strippedKey}/${subKey}${ext}`
                        : `${key}/${subKey}${ext}`;
                    files.push({ path: filePath, content: subValue });
                }
            }
        }
    }

    return files;
}

async function getBranchSha(branchName) {
    try {
        const { data } = await api.get(`/projects/${PROJECT_ID}/repository/branches/${encodeURIComponent(branchName)}`);
        return data.commit.id;
    } catch (err) {
        if (err.response && err.response.status === 404) return null;
        throw err;
    }
}

async function initializeRepoIfEmpty() {
    try {
        await api.get(`/projects/${PROJECT_ID}/repository/branches/${encodeURIComponent(BASE_BRANCH)}`);
    } catch (err) {
        if (err.response && err.response.status === 404) {
            await api.post(`/projects/${PROJECT_ID}/repository/commits`, {
                branch: BASE_BRANCH,
                commit_message: 'Initial commit',
                actions: [{
                    action: 'create',
                    file_path: 'README.md',
                    content: Buffer.from('# C2C Template Backup\nThis repo stores C2C templates per company.', 'utf-8').toString('base64'),
                    encoding: 'base64',
                }],
            });
            console.log('Initialized empty repo with README on main');
        } else {
            throw err;
        }
    }
}

async function getBaseBranchSha() {
    const { data } = await api.get(`/projects/${PROJECT_ID}/repository/branches/${encodeURIComponent(BASE_BRANCH)}`);
    return data.commit.id;
}

async function createBranch(branchName, sha) {
    await api.post(`/projects/${PROJECT_ID}/repository/branches`, {
        branch: branchName,
        ref: sha,
    });
}

// Get all blob file paths currently in a branch (to decide create vs update per file)
async function getExistingFilePaths(branchName) {
    const paths = new Set();
    let page = 1;
    while (true) {
        const { data } = await api.get(`/projects/${PROJECT_ID}/repository/tree`, {
            params: { ref: branchName, recursive: true, per_page: 100, page },
        });
        for (const item of data) {
            if (item.type === 'blob') paths.add(item.path);
        }
        if (data.length < 100) break;
        page++;
    }
    return paths;
}

// Single commit for all files using GitLab Commits API
async function commitAllFiles(branchName, files, commitMessage) {
    const existingPaths = await getExistingFilePaths(branchName);

    const actions = files.map(({ path, content }) => ({
        action: existingPaths.has(path) ? 'update' : 'create',
        file_path: path,
        content: Buffer.from(content, 'utf-8').toString('base64'),
        encoding: 'base64',
    }));

    const { data } = await api.post(`/projects/${PROJECT_ID}/repository/commits`, {
        branch: branchName,
        commit_message: commitMessage,
        actions,
    });

    return data.id; // commit SHA
}

// Get full recursive file tree for a given commit SHA (handles pagination)
async function getFullTree(commitSha) {
    const items = [];
    let page = 1;
    while (true) {
        const { data } = await api.get(`/projects/${PROJECT_ID}/repository/tree`, {
            params: { ref: commitSha, recursive: true, per_page: 100, page },
        });
        items.push(...data);
        if (data.length < 100) break;
        page++;
    }
    return items;
}

// Get blob content by blob SHA (base64-decoded)
async function getBlobContent(blobSha) {
    const { data } = await api.get(`/projects/${PROJECT_ID}/repository/blobs/${blobSha}`);
    return Buffer.from(data.content, 'base64').toString('utf-8');
}

// POST API - create a new branch from company base branch
// new branch name: company-{company_id}-{name}
app.post('/create-branch', async (req, res) => {
    try {
        const { company_id, name } = req.body;

        if (!company_id) return res.status(400).json({ success: false, message: 'company_id is required' });
        if (!name) return res.status(400).json({ success: false, message: 'name is required' });

        const sourceBranch = getBranchName(company_id);
        const newBranchName = `${sourceBranch}-${name}`;

        // Source branch must exist
        const sourceSha = await getBranchSha(sourceBranch);
        if (!sourceSha) {
            return res.status(404).json({ success: false, message: `Source branch not found: ${sourceBranch}` });
        }

        // New branch must not already exist
        const existing = await getBranchSha(newBranchName);
        if (existing) {
            return res.status(409).json({ success: false, message: `Branch already exists: ${newBranchName}` });
        }

        await createBranch(newBranchName, sourceSha);
        console.log(`Created branch: ${newBranchName} from ${sourceBranch}`);

        return res.status(200).json({
            success: true,
            company_id,
            source_branch: sourceBranch,
            new_branch: newBranchName,
        });

    } catch (err) {
        console.error('Error:', err.message || err);
        return res.status(500).json({ success: false, message: gitlabError(err) });
    }
});

// Main API
app.post('/store-template', async (req, res) => {
    try {
        const { company_id, commit, ...templatePayload } = req.body;

        if (!company_id) {
            return res.status(400).json({ success: false, message: 'company_id is required' });
        }

        const branchName = getBranchName(company_id);
        const timestamp = getTimestamp();
        const label = commit ? commit : 'Update templates';
        const commitMessage = `${label} | ${timestamp}`;

        await initializeRepoIfEmpty();

        let branchSha = await getBranchSha(branchName);
        let branchCreated = false;

        if (!branchSha) {
            const baseSha = await getBaseBranchSha();
            await createBranch(branchName, baseSha);
            branchCreated = true;
            console.log(`Created branch: ${branchName}`);
        } else {
            console.log(`Branch already exists: ${branchName}`);
        }

        // Build full file list from whatever keys are in the payload
        let files = buildFileList(templatePayload);

        // If company_id is numeric-only → commit both published & unpublished
        // If company_id contains non-numeric characters → skip published files
        const isNumericOnly = /^\d+$/.test(company_id);
        if (!isNumericOnly) {
            files = files.filter(f => !f.path.startsWith('published/'));
        }

        if (files.length === 0) {
            return res.status(400).json({ success: false, message: 'No valid template data found in payload' });
        }

        const commitSha = await commitAllFiles(branchName, files, commitMessage);
        console.log(`Committed ${files.length} files in 1 commit on branch ${branchName}`);

        return res.status(200).json({
            success: true,
            company_id,
            branch: branchName,
            branch_created: branchCreated,
            committed_at: timestamp,
            commit_sha: commitSha,
            files_committed: files.map(f => f.path),
        });

    } catch (err) {
        console.error('Error:', err.message || err);
        return res.status(500).json({ success: false, message: gitlabError(err) });
    }
});

// GET API - fetch template data by company_id and optional commit SHA
app.get('/get-template', async (req, res) => {
    try {
        const { company_id, commit } = req.query;

        if (!company_id) {
            return res.status(400).json({ success: false, message: 'company_id is required' });
        }

        const branchName = getBranchName(company_id);

        // Check branch exists
        const branchSha = await getBranchSha(branchName);
        if (!branchSha) {
            return res.status(404).json({ success: false, message: `No data found for company_id: ${company_id}` });
        }

        // Use provided commit SHA or fallback to latest commit on branch
        let targetCommitSha = branchSha;
        if (commit) {
            if (commit.length === 40) {
                // Full SHA provided — use directly
                targetCommitSha = commit;
            } else {
                // Short SHA — find full SHA by listing commits
                const { data: commits } = await api.get(`/projects/${PROJECT_ID}/repository/commits`, {
                    params: { ref_name: branchName, per_page: 100 },
                });
                const matched = commits.find(c => c.id.startsWith(commit));
                if (!matched) {
                    return res.status(404).json({ success: false, message: `Commit not found: ${commit}` });
                }
                targetCommitSha = matched.id;
            }
        }

        // Get commit info (for timestamp)
        const { data: commitData } = await api.get(`/projects/${PROJECT_ID}/repository/commits/${targetCommitSha}`);

        // Get full tree at that commit (recursive to include subfolders)
        const treeItems = await getFullTree(targetCommitSha);

        // Filter only blob files (exclude README etc at root)
        const companyFiles = treeItems.filter(
            item => item.type === 'blob' && (item.path.startsWith('published/') || item.path.startsWith('unpublished/'))
        );

        if (companyFiles.length === 0) {
            return res.status(404).json({ success: false, message: 'No files found for this company' });
        }

        // Fetch content of all files in parallel
        const fileContents = await Promise.all(
            companyFiles.map(async (file) => {
                const content = await getBlobContent(file.id);
                return { path: file.path, content };
            })
        );

        // Rebuild nested structure from flat file paths
        // published/c2c_css.css           → published_c2c_css: "..."
        // published/c2c_template/foo.html → published_c2c_template: { foo: "..." }
        const result = {};
        for (const { path, content } of fileContents) {
            const parts = path.split('/');

            if (parts.length === 2) {
                // published/c2c_css.css → published_c2c_css
                const prefix = parts[0];
                const key = parts[1].replace(/\.(css|js|html)$/, '');
                result[`${prefix}_${key}`] = content;
            } else if (parts.length === 3) {
                // published/c2c_template/product_listing.html → published_c2c_template: { product_listing: ... }
                const prefix = parts[0];
                const subFolder = parts[1];
                const key = parts[2].replace(/\.(css|js|html)$/, '');
                const fullKey = `${prefix}_${subFolder}`;
                if (!result[fullKey]) result[fullKey] = {};
                result[fullKey][key] = content;
            }
        }

        return res.status(200).json({
            success: true,
            company_id,
            branch: branchName,
            commit_sha: targetCommitSha,
            committed_at: commitData.authored_date,
            commit_message: commitData.message,
            data: result,
        });

    } catch (err) {
        console.error('Error:', err.message || err);
        return res.status(500).json({ success: false, message: gitlabError(err) });
    }
});

// GET API - list all commits for a company
app.get('/get-commits', async (req, res) => {
    try {
        const { company_id } = req.query;

        if (!company_id) {
            return res.status(400).json({ success: false, message: 'company_id is required' });
        }

        const branchName = getBranchName(company_id);
        const branchSha = await getBranchSha(branchName);

        if (!branchSha) {
            return res.status(404).json({ success: false, message: `No data found for company_id: ${company_id}` });
        }

        const { data: commits } = await api.get(`/projects/${PROJECT_ID}/repository/commits`, {
            params: { ref_name: branchName, per_page: 50 },
        });

        const commitList = commits.map(c => ({
            commit_sha: c.id.substring(0, 7),
            commit_sha_full: c.id,
            message: c.message,
            committed_at: c.authored_date,
        }));

        return res.status(200).json({
            success: true,
            company_id,
            branch: branchName,
            total: commitList.length,
            commits: commitList,
        });

    } catch (err) {
        console.error('Error:', err.message || err);
        return res.status(500).json({ success: false, message: gitlabError(err) });
    }
});

// GET API - get latest commit files/code for a given branch name
app.get('/get-branch-code', async (req, res) => {
    try {
        const { branch, commit_sha } = req.query;

        if (!branch) {
            return res.status(400).json({ success: false, message: 'branch is required' });
        }

        // Verify branch exists
        const latestSha = await getBranchSha(branch);
        if (!latestSha) {
            return res.status(404).json({ success: false, message: `Branch not found: ${branch}` });
        }

        // Use provided commit SHA if given, otherwise fall back to latest
        let targetSha = latestSha;
        if (commit_sha) {
            if (commit_sha.length === 40) {
                targetSha = commit_sha;
            } else {
                // Short SHA — resolve to full SHA
                const { data: commits } = await api.get(`/projects/${PROJECT_ID}/repository/commits`, {
                    params: { ref_name: branch, per_page: 100 },
                });
                const matched = commits.find(c => c.id.startsWith(commit_sha));
                if (!matched) {
                    return res.status(404).json({ success: false, message: `Commit not found: ${commit_sha}` });
                }
                targetSha = matched.id;
            }
        }

        // Get full commit info
        const { data: commitData } = await api.get(`/projects/${PROJECT_ID}/repository/commits/${targetSha}`);

        // Get full recursive file tree at that commit
        const treeItems = await getFullTree(targetSha);
        const blobs = treeItems.filter(item => item.type === 'blob');

        if (blobs.length === 0) {
            return res.status(404).json({ success: false, message: 'No files found in this branch' });
        }

        // Fetch all file contents in parallel
        const fileContents = await Promise.all(
            blobs.map(async (file) => {
                const content = await getBlobContent(file.id);
                return { path: file.path, content };
            })
        );

        // Rebuild same nested structure as /get-template
        const result = {};
        for (const { path, content } of fileContents) {
            const parts = path.split('/');
            if (parts.length === 2) {
                const prefix = parts[0];
                const key = parts[1].replace(/\.(css|js|html)$/, '');
                result[`${prefix}_${key}`] = content;
            } else if (parts.length === 3) {
                const prefix = parts[0];
                const subFolder = parts[1];
                const key = parts[2].replace(/\.(css|js|html)$/, '');
                const fullKey = `${prefix}_${subFolder}`;
                if (!result[fullKey]) result[fullKey] = {};
                result[fullKey][key] = content;
            }
        }

        return res.status(200).json({
            success: true,
            branch,
            commit_sha: targetSha.substring(0, 7),
            commit_sha_full: targetSha,
            committed_at: commitData.authored_date,
            commit_message: commitData.message,
            data: result,
        });

    } catch (err) {
        console.error('Error:', err.message || err);
        return res.status(500).json({ success: false, message: gitlabError(err) });
    }
});

// GET API - autocomplete branch names, ordered by newest commit, optional title filter
app.get('/branches', async (req, res) => {
    try {
        const { title } = req.query;
        const search = title ? title.trim() : '';

        // Fetch up to 300 branches across 3 pages
        // GitLab branch listing already includes commit date — no extra API calls needed
        let allBranches = [];
        for (let page = 1; page <= 3; page++) {
            const { data } = await api.get(`/projects/${PROJECT_ID}/repository/branches`, {
                params: { per_page: 100, page, ...(search && { search }) },
            });
            allBranches = allBranches.concat(data);
            if (data.length < 100) break;
        }

        const withDates = allBranches.slice(0, 60).map(branch => ({
            name: branch.name,
            commit_sha: branch.commit.id.substring(0, 7),
            commit_sha_full: branch.commit.id,
            committed_at: branch.commit.committed_date,
        }));

        // Sort newest first
        withDates.sort((a, b) => {
            if (!a.committed_at && !b.committed_at) return 0;
            if (!a.committed_at) return 1;
            if (!b.committed_at) return -1;
            return new Date(b.committed_at) - new Date(a.committed_at);
        });

        return res.status(200).json({
            success: true,
            total: allBranches.length,
            branches: withDates.slice(0, 30),
        });

    } catch (err) {
        console.error('Error:', err.message || err);
        return res.status(500).json({ success: false, message: gitlabError(err) });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`C2C GitLab backup service running on port ${PORT}`);
});

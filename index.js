require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Octokit } = require('@octokit/rest');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';

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
        const { data } = await octokit.repos.getBranch({ owner: OWNER, repo: REPO, branch: branchName });
        return data.commit.sha;
    } catch (err) {
        if (err.status === 404) return null;
        throw err;
    }
}

async function initializeRepoIfEmpty() {
    try {
        await octokit.repos.getBranch({ owner: OWNER, repo: REPO, branch: BASE_BRANCH });
    } catch (err) {
        if (err.status === 404) {
            await octokit.repos.createOrUpdateFileContents({
                owner: OWNER,
                repo: REPO,
                path: 'README.md',
                message: 'Initial commit',
                content: Buffer.from('# C2C Template Backup\nThis repo stores C2C templates per company.', 'utf-8').toString('base64'),
                branch: BASE_BRANCH,
            });
            console.log('Initialized empty repo with README on main');
        } else {
            throw err;
        }
    }
}

async function getBaseBranchSha() {
    const { data } = await octokit.repos.getBranch({ owner: OWNER, repo: REPO, branch: BASE_BRANCH });
    return data.commit.sha;
}

async function createBranch(branchName, sha) {
    await octokit.git.createRef({ owner: OWNER, repo: REPO, ref: `refs/heads/${branchName}`, sha });
}

// Single commit for all files using Git Tree API
async function commitAllFiles(branchName, files, commitMessage) {
    const { data: refData } = await octokit.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${branchName}` });
    const latestCommitSha = refData.object.sha;

    const { data: commitData } = await octokit.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: latestCommitSha });
    const baseTreeSha = commitData.tree.sha;

    const treeItems = await Promise.all(
        files.map(async ({ path, content }) => {
            const { data: blob } = await octokit.git.createBlob({
                owner: OWNER,
                repo: REPO,
                content: Buffer.from(content, 'utf-8').toString('base64'),
                encoding: 'base64',
            });
            return { path, mode: '100644', type: 'blob', sha: blob.sha };
        })
    );

    const { data: newTree } = await octokit.git.createTree({ owner: OWNER, repo: REPO, base_tree: baseTreeSha, tree: treeItems });

    const { data: newCommit } = await octokit.git.createCommit({
        owner: OWNER,
        repo: REPO,
        message: commitMessage,
        tree: newTree.sha,
        parents: [latestCommitSha],
    });

    await octokit.git.updateRef({ owner: OWNER, repo: REPO, ref: `heads/${branchName}`, sha: newCommit.sha });

    return newCommit.sha;
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
        return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
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
        return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
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
                const { data: commits } = await octokit.repos.listCommits({
                    owner: OWNER, repo: REPO, sha: branchName, per_page: 100,
                });
                const matched = commits.find(c => c.sha.startsWith(commit));
                if (!matched) {
                    return res.status(404).json({ success: false, message: `Commit not found: ${commit}` });
                }
                targetCommitSha = matched.sha;
            }
        }

        // Get commit info (for timestamp)
        const { data: commitData } = await octokit.git.getCommit({
            owner: OWNER, repo: REPO, commit_sha: targetCommitSha,
        });

        // Get full tree at that commit (recursive to include subfolders)
        const { data: treeData } = await octokit.git.getTree({
            owner: OWNER, repo: REPO, tree_sha: commitData.tree.sha, recursive: 'true',
        });

        // Filter only blob files (exclude README etc at root)
        const companyFiles = treeData.tree.filter(
            item => item.type === 'blob' && (item.path.startsWith('published/') || item.path.startsWith('unpublished/'))
        );

        if (companyFiles.length === 0) {
            return res.status(404).json({ success: false, message: 'No files found for this company' });
        }

        // Fetch content of all files in parallel
        const fileContents = await Promise.all(
            companyFiles.map(async (file) => {
                const { data: blob } = await octokit.git.getBlob({
                    owner: OWNER, repo: REPO, file_sha: file.sha,
                });
                const content = Buffer.from(blob.content, 'base64').toString('utf-8');
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
            committed_at: commitData.author.date,
            commit_message: commitData.message,
            data: result,
        });

    } catch (err) {
        console.error('Error:', err.message || err);
        return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
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

        const { data: commits } = await octokit.repos.listCommits({
            owner: OWNER, repo: REPO, sha: branchName, per_page: 50,
        });

        const commitList = commits.map(c => ({
            commit_sha: c.sha.substring(0, 7),
            commit_sha_full: c.sha,
            message: c.commit.message,
            committed_at: c.commit.author.date,
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
        return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`C2C GitHub backup service running on port ${PORT}`);
});

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
    return `company-${company_id}`;
}

// Determine file extension based on key name
function getFileExtension(key) {
    if (key.includes('css')) return '.css';
    if (key.includes('script') || key.includes('js')) return '.js';
    return '.html';
}

// Flatten payload into file list
// Handles: top-level strings, top-level objects (nested templates)
function buildFileList(company_id, payload) {
    const files = [];
    const SKIP_KEYS = ['company_id'];

    for (const [key, value] of Object.entries(payload)) {
        if (SKIP_KEYS.includes(key)) continue;

        if (typeof value === 'string') {
            // Top-level string: e.g. published_c2c_css → company_id/published_c2c.css
            const ext = getFileExtension(key);
            files.push({ path: `${company_id}/${key}${ext}`, content: value });

        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            // Nested object: e.g. unpublished_c2c_template.product_listing → company_id/unpublished_c2c_template/product_listing.html
            for (const [subKey, subValue] of Object.entries(value)) {
                if (typeof subValue === 'string') {
                    const ext = getFileExtension(subKey);
                    files.push({ path: `${company_id}/${key}/${subKey}${ext}`, content: subValue });
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

// Main API
app.post('/store-template', async (req, res) => {
    try {
        const { company_id, ...templatePayload } = req.body;

        if (!company_id) {
            return res.status(400).json({ success: false, message: 'company_id is required' });
        }

        const branchName = getBranchName(company_id);
        const timestamp = getTimestamp();
        const commitMessage = `[${company_id}] Update templates | ${timestamp}`;

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
        const files = buildFileList(company_id, templatePayload);

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

        // Filter only files under company_id folder
        const companyFiles = treeData.tree.filter(
            item => item.type === 'blob' && item.path.startsWith(`${company_id}/`)
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
        const result = {};
        for (const { path, content } of fileContents) {
            // Remove company_id/ prefix and strip extension
            const relativePath = path.replace(`${company_id}/`, '');
            const parts = relativePath.split('/');

            if (parts.length === 1) {
                // Top-level file: published_c2c_css.css → published_c2c_css
                const key = parts[0].replace(/\.(css|js|html)$/, '');
                result[key] = content;
            } else if (parts.length === 2) {
                // Nested file: published_c2c_template/product_listing.html
                const folder = parts[0];
                const key = parts[1].replace(/\.(css|js|html)$/, '');
                if (!result[folder]) result[folder] = {};
                result[folder][key] = content;
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
            commit_sha: c.sha,
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

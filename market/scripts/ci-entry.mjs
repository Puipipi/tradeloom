/** Read the one allowed submission from immutable Git objects, without checking out PR code. */
const ENTRY_PATH = /^plugins\/(?:@[a-z0-9][a-z0-9._~-]*__)?[a-z0-9][a-z0-9._~-]*\.json$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_ENTRY_BYTES = 16384;
const regular = (entry) => entry?.type === 'blob' && ['100644', '100755'].includes(entry.mode);

export async function submission(github, { repository, headRepository, base, head }) {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error('Expected immutable base/head SHAs');
  // pulls.listFiles follows the live PR ref. Its blobs could come from another revision even
  // after checking the PR head, so compare only the captured commit IDs instead.
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...repository,
    basehead: `${base}...${head}`,
    per_page: 1,
    page: 1,
  });
  // GitHub returns changed files on the first page (at most 300). More than one is ineligible.
  const files = comparison.files;
  if (
    !Array.isArray(files) || files.length !== 1 ||
    !ENTRY_PATH.test(files[0].filename) || !['added', 'modified'].includes(files[0].status)
  ) throw new Error('Automatic submission accepts exactly one added/modified plugins/*.json; maintenance changes require maintainer review.');
  const file = files[0];
  const { data: commit } = await github.rest.git.getCommit({ ...headRepository, commit_sha: head });
  if (commit.sha !== head) throw new Error('Unexpected head commit');
  const { data: root } = await github.rest.git.getTree({ ...headRepository, tree_sha: commit.tree.sha });
  if (root.truncated) throw new Error('Incomplete head tree');
  const directory = root.tree.find((entry) => entry.path === 'plugins');
  if (directory?.type !== 'tree' || directory.mode !== '040000') throw new Error('Expected plugins directory');
  const { data: entries } = await github.rest.git.getTree({ ...headRepository, tree_sha: directory.sha });
  if (entries.truncated) throw new Error('Incomplete plugins tree');
  const entry = entries.tree.find((candidate) => candidate.path === file.filename.slice('plugins/'.length));
  // A symlink also has a blob containing text. Checking only that its content parses as JSON
  // would audit a regular file while the eventual checkout/publisher follows a symlink.
  if (!regular(entry) || entry.sha !== file.sha) throw new Error('Expected matching regular JSON file at head');
  const { data: blob } = await github.rest.git.getBlob({ ...headRepository, file_sha: entry.sha });
  if (blob.sha !== entry.sha || blob.size > MAX_ENTRY_BYTES || blob.encoding !== 'base64')
    throw new Error('Invalid entry blob');
  const bytes = Buffer.from(blob.content, 'base64');
  if (bytes.length !== blob.size || bytes.length > MAX_ENTRY_BYTES) throw new Error('Invalid entry size');
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return { path: file.filename, bytes };
}

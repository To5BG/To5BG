import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const listReposQuery = readFileSync(join(__dirname, 'list_repos.graphql'), 'utf8');
const repoDetailsQuery = readFileSync(join(__dirname, 'repo_details.graphql'), 'utf8');

export {
    listReposQuery,
    repoDetailsQuery
}; 
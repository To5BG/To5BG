import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const privateReposQuery = readFileSync(join(__dirname, 'private-repos.graphql'), 'utf8');
const contributionsQuery = readFileSync(join(__dirname, 'contributions.graphql'), 'utf8');

export {
    privateReposQuery,
    contributionsQuery
}; 
import * as os from 'node:os';
import * as path from 'node:path';

export function getDefaultTemplateRepoDir(): string {
    const home = os.homedir();
    return path.join(home, '.cache', 'aas-ci-lint', 'submodel-templates');
}

export function getDefaultTemplateDir(): string {
    return path.join(getDefaultTemplateRepoDir(), 'published');
}

import { isAbsolute, relative, resolve, sep } from 'node:path';

export function resolvePathWithinRoot(allowedRoot, candidatePath) {
  const rootPath = resolve(allowedRoot);
  const candidate = resolve(candidatePath);
  const pathFromRoot = relative(rootPath, candidate);
  if (isAbsolute(pathFromRoot) || pathFromRoot.split(sep).includes('..')) {
    return undefined;
  }
  return candidate;
}

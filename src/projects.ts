import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './sessions.ts';

export type Project = { name: string; path: string; git: boolean };

/** The folders directly under the workspace root: what "project" names refer to. */
export async function listProjects(root: string): Promise<Project[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const projects = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map(async (e) => {
        const full = path.join(root, e.name);
        const git = await fs.stat(path.join(full, '.git')).then(
          () => true,
          () => false,
        );
        return { name: e.name, path: full, git };
      }),
  );
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Turns a project name (or a relative path such as "homelab/docs") into a
 * folder inside the workspace root. No project = the root itself.
 * Matching is case-insensitive for top-level names, because voice-to-text
 * rarely gets the case right. Symlinks pointing outside the root are refused.
 */
export async function resolveProject(root: string, project: string | undefined): Promise<{ project: string; cwd: string }> {
  const realRoot = await fs.realpath(root);
  const name = project?.trim().replace(/\/+$/, '') ?? '';
  if (!name || name === '.') return { project: '.', cwd: realRoot };
  if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
    throw new ApiError(400, 'BAD_PROJECT', 'project must be a folder name or a relative path inside the workspace');
  }

  let candidate = path.join(realRoot, name);
  if (!(await exists(candidate)) && !name.includes('/')) {
    const match = (await listProjects(realRoot)).find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (match) candidate = match.path;
  }

  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw new ApiError(404, 'PROJECT_NOT_FOUND', `No project "${name}". GET /projects lists them.`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new ApiError(400, 'BAD_PROJECT', 'project resolves outside the workspace');
  }
  if (!(await fs.stat(real)).isDirectory()) throw new ApiError(400, 'BAD_PROJECT', `"${name}" is not a folder`);
  return { project: path.relative(realRoot, real) || '.', cwd: real };
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

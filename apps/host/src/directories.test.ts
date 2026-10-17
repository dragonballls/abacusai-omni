import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { listDirectory, makeDirectory } from "./directories";

it("lists VM paths, clamps parents and symlinks, and creates one folder safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-picker-"));
  // Windows' temp directory is often inside the normal user home. Give the
  // test an isolated home so the bot-root boundary is the same on every OS.
  const isolatedHome = join(root, "isolated-user-home");
  await mkdir(isolatedHome);
  vi.stubEnv("HOME", isolatedHome);
  vi.stubEnv("USERPROFILE", isolatedHome);
  vi.stubEnv("ABACUSAI_BOT_HOME", root);
  try {
    const home = join(root, "bot-home");
    await mkdir(home);
    await mkdir(join(home, "empty"));
    await writeFile(join(home, "Résumé notes.txt"), "notes");
    await symlink(tmpdir(), join(home, "outside"));
    const listing = await listDirectory();
    expect(listing.root).toBe(await realpath(root));
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "empty",
      "Résumé notes.txt",
    ]);
    expect((await listDirectory(join(home, "empty"))).entries).toEqual([]);
    await expect(listDirectory(join(home, "outside"))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(listDirectory(tmpdir())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(listDirectory(join(home, "missing"))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    for (const name of ["..", "../escape", "a/b", "a\\b", ""])
      await expect(makeDirectory(home, name)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    const created = await makeDirectory(home, "New workspace");
    expect((await listDirectory(created.path)).entries).toEqual([]);
    await expect(makeDirectory(home, "New workspace")).rejects.toThrow();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

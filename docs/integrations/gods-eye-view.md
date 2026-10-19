# God's Eye View source

This directory is a Git submodule pinned to the upstream **God's Eye View** project. It is included as a source reference for future integration work; it is not currently wired into the AbacusAI Bot UI or packaged desktop build.

- **Upstream:** https://github.com/bilawalsidhu/gods-eye-view
- **Pinned upstream commit:** [5597c81e7c064414cc43b1fa8ebe0d6bac65e6a8](https://github.com/bilawalsidhu/gods-eye-view/commit/5597c81e7c064414cc43b1fa8ebe0d6bac65e6a8)
- **Pin date:** 2026-10-19
- **License:** The upstream repository states that its source code is MIT-licensed. That grant does not cover all included datasets, map data, feeds, or 3D assets; consult the upstream `LICENSE`, `DATA_SOURCES.md`, and `public/models/README.md` before redistributing or using those components.

## Initialize the source

For a fresh checkout, include submodules:

```bash
git clone --recurse-submodules https://github.com/dragonballls/abacusai-omni.git
```

For a checkout already on disk:

```bash
git submodule update --init --recursive integrations/gods-eye-view
```

The source is pinned so builds and research do not silently drift when upstream changes. To intentionally advance it to the latest upstream `main` revision:

```bash
git submodule update --remote integrations/gods-eye-view
git diff --submodule
git add .gitmodules integrations/gods-eye-view
git commit -m "Update pinned God's Eye View source"
```

Review the upstream changes and all relevant asset/data terms before accepting an update. The standalone app documents Node.js 24.x (24.14.0 or later) or 26.x and launches separately from its own directory; follow its current README for setup. This pin does not make God’s Eye part of the Abacus desktop runtime and does not add its dependencies to the Abacus build.

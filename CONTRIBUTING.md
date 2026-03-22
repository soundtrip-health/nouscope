# Contributing

## Dev Setup

```bash
git clone https://github.com/soundtrip-health/nouscope.git
cd nouscope
npm install
npm run dev
```

Open `http://localhost:5173`. Use Chrome or Edge when you need Web Bluetooth (EEG); the visualizer alone works in any modern browser.

## Branch Convention

- `main` — stable, release-ready
- `feat-<name>` — new features
- `fix-<name>` — bug fixes

## Submitting a PR

1. Fork the repo and create a branch from `main`
2. Make your changes — keep them focused and minimal
3. Run `npm run build` to verify the build passes
4. Open a pull request with a clear description of what changed and why

## Notes

- EEG features require Chrome or Edge (Web Bluetooth API)
- HTTPS is required for Web Bluetooth in production deployments
- Shader files live in `src/js/entities/glsl/` and are imported via `rollup-plugin-glslify`

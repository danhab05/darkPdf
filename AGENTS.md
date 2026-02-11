# Repository Guidelines

## Project Structure & Module Organization
- `src/app/`: Next.js App Router pages, layout, and styles. Main UI is `src/app/page.tsx` and `src/app/page.module.css`.
- `src/app/layout.tsx`: Root layout, fonts, and metadata.
- `src/app/globals.css`: Global resets and base typography.
- `public/`: Static assets (icons, images).
- No dedicated test directory is present yet.

## Build, Test, and Development Commands
- `npm install`: Install dependencies.
- `npm run dev`: Start local dev server at `http://localhost:3000`.
- `npm run build`: Production build.
- `npm run start`: Run the production build locally.
- `npm run lint`: Run ESLint (Next.js config).

## Coding Style & Naming Conventions
- Language: TypeScript + React (Next.js App Router).
- Indentation: 2 spaces (match existing files).
- File naming: `kebab-case` for CSS modules and files, `camelCase` for variables/functions, `PascalCase` for React components.
- Styles: Prefer CSS Modules (`*.module.css`) for page-level styling.
- Linting: ESLint via `npm run lint`.

## Testing Guidelines
- No automated tests are configured yet.
- If you add tests, document the framework and add scripts in `package.json`.
- Suggested naming: `*.test.ts` / `*.test.tsx` colocated near the feature or in a `tests/` folder.

## Commit & Pull Request Guidelines
- Commit messages are short, sentence-style summaries (e.g., “Reduce PDF output size with adaptive DPI and cap”).
- Prefer imperative, descriptive messages without prefixes unless the repo adopts them later.
- PRs should include:
  - A clear summary of changes.
  - Screenshots for UI changes (before/after if meaningful).
  - Notes on performance or size impacts for PDF processing.

## Security & Configuration Notes
- PDF processing runs client-side; do not introduce server-side uploads without explicit product approval.
- Keep any new secrets out of the repo and document required env vars in `README.md` if added.

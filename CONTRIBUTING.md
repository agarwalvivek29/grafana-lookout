# Contributing to Lookout

Thanks for helping. Bug reports, docs fixes, new data source adapters and design feedback are all welcome.

- **Questions and ideas:** [GitHub Discussions](https://github.com/agarwalvivek29/grafana-lookout/discussions).
- **Bugs and planned work:** [issues](https://github.com/agarwalvivek29/grafana-lookout/issues). See the
  [roadmap](ROADMAP.md) for what is coming next.
- **Security problems:** do not open an issue; follow [SECURITY.md](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

For anything bigger than a small fix, open an issue (or comment on an existing one) first so we can agree on
the approach before you spend time on it. Issues labelled `good first issue` are a good place to begin.

## Development setup

Requirements: Node.js 22 (see `.nvmrc`), Go (version in `go.mod`), Docker.

```sh
git clone https://github.com/agarwalvivek29/grafana-lookout.git
cd grafana-lookout
npm install
go run github.com/magefile/mage@v1.15.0 -v   # backend binaries for all platforms

cp .env.example .env                          # your model endpoint and key (git-ignored)
npm run dev                                   # frontend, rebuilds on change
docker compose up --build                     # Grafana on http://localhost:3000 (admin/admin)
```

To try changes against realistic data (Prometheus, Loki, Tempo and demo traffic), build once and use
[`examples/quickstart`](examples/quickstart).

## Checks

Run these before opening a pull request; CI runs the same ones.

```sh
npm run typecheck
npm run lint            # npm run lint:fix to fix formatting
npm run test:ci         # unit tests
go test ./pkg/...
npm run e2e             # Playwright, needs the dev Grafana running
```

## Code map

| Path                        | What it holds                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `src/agent/agent.ts`        | The agent loop and its tools. Tools are read-only and call Grafana APIs as the user. |
| `src/chat/`                 | Chat UI, side panel, safe Markdown, link previews, conversation store.               |
| `src/components/AppConfig/` | The setup page.                                                                      |
| `src/module.tsx`            | Entry points: dashboard sidebar, panel menu, command palette.                        |
| `pkg/`                      | Go backend (small today).                                                            |
| `examples/quickstart/`      | Demo stack used for manual testing and the plugin review.                            |

## Rules for changes

These keep Lookout safe to install. Pull requests that break them will not be merged.

1. **Tools are read-only.** A tool may query data and Grafana metadata. Anything that changes Grafana must go
   through a preview and an explicit Apply by the user.
2. **Run as the user.** Call Grafana's HTTP APIs from the browser with the user's session (`getBackendSrv`).
   Never use service account tokens or stored credentials to read data on a user's behalf.
3. **Tool results are untrusted.** Log lines, trace attributes and dashboard text can contain text written by
   anyone. Keep them labelled as data in tool output, and never let them change instructions or tools.
4. **Keep output safe.** Model output is rendered only through `SafeMarkdown`: no raw HTML, no images, and only
   links into this Grafana are clickable.
5. **Bound every result.** Cap the number of series, lines and traces a tool returns, and say when a result was
   cut.
6. **Stay vendor neutral.** No company-specific names, endpoints or defaults in code, docs or examples.
7. **Add tests.** New tools and adapters need unit tests with mocked Grafana responses (see
   `src/agent/agent.test.ts`).

## Adding a data source adapter

1. Find where the signal's tools dispatch on the data source type (for logs: `runLogTool` in
   `src/agent/agent.ts`).
2. Add a function per tool that translates the tool's arguments into the data source's query and turns the
   response into the same compact JSON shape the other adapters return.
3. Add the data source type to `SUPPORTED_TYPES` in `src/components/AppConfig/AppConfig.tsx` so the setup page
   lists it, and mention the query syntax in the tool description.
4. Add unit tests, and add the data source to the support table in `README.md`.

## Pull requests

- Keep each pull request to one change, and describe what it does and how you tested it.
- Update docs (`README.md`, `src/README.md` for the catalog page) when behaviour changes.
- Add a line to `CHANGELOG.md` under the unreleased section.
- A maintainer reviews every pull request; expect a reply within a week.

## Sign your commits (DCO)

Lookout uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). By signing off a
commit you certify that you wrote it or otherwise have the right to submit it under the project's license
(Apache 2.0). Add the sign-off with `-s`:

```sh
git commit -s -m "Add OpenSearch logs adapter"
```

This adds a line like `Signed-off-by: Your Name <you@example.com>` that must match the commit author. A CI
check fails pull requests with unsigned commits. To fix it:

```sh
git rebase --signoff main
git push --force-with-lease
```

## Releases

Maintainers release by bumping the version in `package.json`, moving the `CHANGELOG.md` entries under the new
version, and pushing a `vX.Y.Z` tag. The release workflow builds, signs and attaches the plugin zip to a GitHub
release, which is then submitted to the Grafana plugin catalog.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

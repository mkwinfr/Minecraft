# Bedrock Panel

Windows desktop launcher for Minecraft Bedrock dedicated server hosting.

## Workspace layout

- `apps/api`: Local service layer for Bedrock install, lifecycle, telemetry, properties, and packs.
- `apps/web`: React renderer used inside the desktop app.
- `apps/desktop`: Electron launcher that owns the local service runtime.
- `packages/shared`: Shared TypeScript contracts.

## Desktop product shape

Bedrock Panel is now intended to ship as a Windows desktop application.

- The Electron app is the product entrypoint.
- The API only runs locally and is started by the desktop shell.
- The built UI is loaded inside the launcher window.
- Server files default to the app-managed data folder under the current user's app data directory.

There is no supported standalone web deployment target.

## Quick start (Development)

1. Install dependencies:

```bash
npm install
```

2. Start the desktop development stack:

```bash
npm run dev:desktop
```

This starts the local API, the Vite renderer, and Electron together.

## Build the installer

```bash
npm run build:desktop
```

Installer output is written to `release/`.

## Desktop runtime

The desktop app preserves the existing core feature set:

- Bedrock install and update
- Start, stop, and restart
- Live logs and console feed
- Telemetry and server health metrics
- Server properties editing
- Behavior and resource pack management

## Scripts

- `npm run dev:desktop` - run the local API, renderer, and Electron together
- `npm run build:production` - build the internal service and renderer bundle
- `npm run build:desktop` - produce a Windows installer
- `npm run pack:desktop` - produce an unpacked desktop build for testing
- `npm run typecheck` - TypeScript checks for all workspaces
- `npm run lint` - lint API/shared and web

## Current status

The launcher now owns the local API lifecycle in desktop mode, which is the base required for a real installed application rather than a passive Electron wrapper.

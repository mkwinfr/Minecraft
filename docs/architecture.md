# Architecture

## Overview

This repository is a monorepo with three workspaces:

- `apps/api`: Local control service for server lifecycle, logs, installer, config, packs, and telemetry.
- `apps/web`: React renderer used inside the desktop launcher.
- `apps/desktop`: Electron host that starts and owns the local control service.
- `packages/shared`: Shared API contracts and domain types.

## Runtime model

- Electron is the product entrypoint.
- In development, the renderer and local service run separately for fast iteration.
- In packaged desktop builds, Electron starts the local API process on loopback and loads the app from that local service.
- Bedrock operations remain isolated in the service layer, while the renderer stays focused on UI state and workflows.

## Desktop data model

- The default managed Bedrock server directory lives under the Electron user data folder.
- The installed application directory is treated as read-only runtime code.
- Server state, logs, and mutable Bedrock files belong to app-managed data paths, not the installation directory.

## Current priorities

- Finish packaging and installer polish for Windows distribution.
- Expand the Server Files area into broader file management workflows.
- Add desktop-native behaviors such as tray/minimize, startup options, and recovery flows.

# Wise Statements

Node 24 TypeScript script for downloading Wise balance statements as JSON.

## Setup

Run these from the project root:

```sh
mise trust mise.toml
mise install
pnpm install
cp .env.example .env
```

Set `WISE_API_TOKEN` in `.env`.

## Scope

This is for Wise business profiles where Wise supports balance statements via personal API tokens.

Wise documents that EU/UK profiles cannot view balance statements via personal API tokens due to PSD2. Personal profiles are not supported by this private-key SCA signing flow.

## Wise SCA key setup

Business balance statements require SCA signing.

Generate a keypair:

```sh
pnpm generate-keypair
```

Upload this file in Wise under API tokens / Manage public keys for each business profile you want to use:

```text
keys/wise-public.pem
```

Keep this file local:

```text
keys/wise-private.pem
```

Public keys are profile-specific. A key uploaded for one business profile does not authorize another business profile.

Use a different keypair with:

```sh
pnpm statements --profile-name "Example Business Ltd" --private-key keys/example-business-private.pem --start 2026-01-01 --end 2026-01-31
```

Upload the matching public key for that profile.

## Usage

List profiles:

```sh
pnpm list-profiles
```

Download statements:

```sh
pnpm statements --start 2026-01-01 --end 2026-01-31
```

Use a specific profile:

```sh
pnpm statements --profile-id 123456 --start 2026-01-01 --end 2026-01-31
pnpm statements --profile-name "Example Business Ltd" --start 2026-01-01 --end 2026-01-31
```

Choose currencies:

```sh
pnpm statements --start 2026-01-01 --end 2026-01-31 --currencies USD,EUR,GBP
```

Statements are written to `statements/`, which is gitignored.

# Changelog

## 0.4.0

- Remove the built-in quota-provider default and supplier-adapter packaging option.
- Discover quota sources from Magpie or compatible gateways; retain explicit source selection.
- Support HTTPS gateways, URL path prefixes and optional environment-based Bearer authentication.
- Refresh only the resolved quota source; preserve successful readings after refresh failures.
- Ship a universal macOS popup for Apple Silicon and Intel, with source and third-party notices.
- Publish gateway API, installation and local-storage compatibility documentation.

## 0.3.4

- Read native Antigravity request metadata when no matching gateway trace exists.
- Label native request speed separately from gateway decode speed.

## 0.3.3

- Prefer the Orca domain session database; use the journal database only when the domain file is absent.
- Preserve agent, model and effort metadata when speed statistics are unavailable.

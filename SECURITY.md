# Security Policy

## Supported Versions

Each package under `@qnsc-vn/*` is versioned independently. Only the latest
published minor of each package is supported; older releases should be upgraded.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues by emailing: **security@qnsc.vn**

Include:

- Affected package(s) and version(s)
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

You will receive an acknowledgement within **48 hours** and a status update
within **7 days**.

## Disclosure Policy

- We follow [responsible disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure).
- Once a fix is released, we will publish a security advisory on GitHub.
- Credit will be given to the reporter unless anonymity is requested.

## Scope

This repository publishes shared **application-layer** packages (identity/auth,
cache, HTTP bootstrap) consumed by QNSC product backends. In scope:

- Authentication / session / token-handling flaws in `@qnsc-vn/identity`
- CSRF, cookie, or same-origin regressions
- Insecure defaults in `@qnsc-vn/platform-http` (CORS, headers, cookies)
- Cache poisoning / denylist bypass in `@qnsc-vn/platform-cache`
- Supply-chain risks (unpinned dependencies, publish-pipeline compromise)

Out of scope:

- Denial of service attacks
- Social engineering
- Issues requiring physical access

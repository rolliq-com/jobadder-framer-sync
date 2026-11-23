# Security policy

## Reporting a vulnerability

Report security problems privately. **Never open a public issue for a vulnerability.**

Use GitHub's private vulnerability reporting: open this repository's **Security** tab and click
**Report a vulnerability**. Only you and the maintainers can see the report.

Or email: security@rolliq.com

## What to include

- What the problem is, and what an attacker could do with it.
- The release or commit you looked at (`/status` shows a live Worker's release).
- Steps to reproduce it, or a proof of concept, using synthetic data only.
- Any log lines, with secrets, hostnames and personal information removed.
- Whether you are aware of it being used against a live deployment.

Never include a real password, API key, feed login or job-board data in a report.

## What happens next

We aim to acknowledge a report within 5 working days. We will keep you updated while we look into
it, and credit you in the fix's release notes unless you would rather not be named.

## Scope

This repository's code and documentation. Each deployment runs in its site owner's own Cloudflare
account; problems with a particular deployment's settings or accounts are for that site owner.

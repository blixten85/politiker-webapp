# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | ✅ Yes    |

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public issue.

Instead, use [GitHub's private reporting feature](https://github.com/blixten85/politiker-webapp/security/advisories/new) to report it confidentially.

You should receive a response within 48 hours. If the issue is confirmed, we will release a patch as soon as possible.

## Security Best Practices

- Always use environment variables / Wrangler secrets — never commit credentials
- Användarnas SMTP-lösenord krypteras (AES-GCM) innan de lagras i D1 — nyckeln finns aldrig i koden
- Kontolösenord hashas med PBKDF2, aldrig i klartext
- Keep dependencies updated (Dependabot enabled)

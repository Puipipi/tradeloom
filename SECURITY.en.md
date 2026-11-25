# Reporting security issues

[中文](SECURITY.md)

Keep exploit details, credentials, private keys, real user data and complete diagnostic archives out of public issues, comments and pull requests.

## Report privately

Open this repository's [Security Advisories](https://github.com/ccch1mneyyy/dsh-go/security/advisories) page:

- If **Report a vulnerability** is available, use it to submit a private report.
- If it is unavailable, open an issue asking only how to contact the maintainer privately, then wait for a private contact route. Do not describe the vulnerability, attach reproduction data or identify an affected deployment in that public issue.

A `SECURITY.md` file does not enable GitHub's private vulnerability reporting feature. Confirm that you are using a private reporting form before submitting details.

## What to include

- App version, build number, and relevant engine or plugin versions. Include a commit for source-level reports.
- Android version, ABI, and whether the connection is local, SSH or DSH Remote.
- Impact, preconditions and minimal reproduction steps.
- A reproduction using fictional content, test accounts or synthetic fixtures, plus only the necessary redacted logs.
- What you have and have not verified, including results from other versions if available.

Real API keys, SSH private keys, login tokens and links granting access to private conversations are not required. If your own credentials have been exposed, revoke or replace them with the relevant service first.

## Scope and testing boundaries

Reports may cover the app, Dart communication packages, bundled bridge, runtime patches and companion services in this repository. Examples include credential exposure, unauthorized file access, approval bypasses, unauthorized phone actions and sharing access-control problems. For third-party dependency issues, identify the component and pinned version.

Reproduce issues only with your own devices, accounts and data, or in environments where you have authorization. Do not access other people's content, perform destructive actions or disrupt live services to validate a report. This policy does not authorize testing third-party services.

The local engine can execute tools and load plugins. Running the engine on the phone does not mean model requests stay on the device. See the [user guide](docs/guide/README.md) for permissions, model data and usage statistics.

## Handling and disclosure

Use the private channel to discuss reproduction, impact and fix validation, then coordinate public disclosure with the maintainer. Identify affected versions in the report. This policy makes no fixed response-time, repair-deadline, bounty or long-term version-support commitment.

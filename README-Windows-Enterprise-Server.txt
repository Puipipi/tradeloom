TradeLoom Enterprise Server for Windows x64

Graphical local server launcher:
1. Extract this ZIP into a new folder and double-click Start-ServerGui.vbs.
2. A native Windows graphical window opens without a terminal. Click the start-service button.
3. If no administrator exists, fill in your own username, password and confirmation in the window, then click create-first-administrator. No account is prefilled and no administrator password is saved by the launcher.
4. Click open-management-console to open the existing web management console and log in.
The default data directory is %LOCALAPPDATA%\TradeLoomEnterpriseServer; ports are HTTP 27417 and private PostgreSQL 56427. Existing installations reuse their saved ports, app/runtime and data without replacing configuration or restarting a healthy service. Closing the window leaves the service running. A nonempty directory without server-config.json is refused and retained.
For a custom existing installation, a shortcut may target Windows wscript.exe with arguments:
"<package>\Start-ServerGui.vbs" -DataRoot "<existing-data-directory>" -Port 27814 -PostgresPort 56814
Optional -RuntimeSource selects a trusted runtime bundle for a fresh install. See docs/enterprise-server-gui.md.

Command-line installation remains available:
Open PowerShell in the package folder and run .\Install-EnterpriseServer.ps1; this original entry asks for administrator credentials interactively.

First install behind an already configured HTTPS reverse proxy:
Run .\Install-EnterpriseServer.ps1 -ExternalHttpsUrl "https://trade.example.com/enterprise/".
This enables Django HTTPS proxy mode, trusted Host and CSRF origin checks, HTTPS redirects, and Secure session/CSRF cookies. The installer starts the application on loopback HTTP; it does not create a TLS certificate, reverse proxy, tunnel, or DNS record. The trusted proxy must preserve the public Host and set X-Forwarded-Proto: https before forwarding to 127.0.0.1:27417.

The HTTPS URL must use the https scheme, contain no user information, query, or fragment, and have only an empty path, /, or /enterprise/. Do not expose the loopback HTTP or PostgreSQL port directly.

Enable HTTPS for an existing stopped install:
Run .\Stop-EnterpriseServer.ps1 first, then .\Start-EnterpriseServer.ps1 -EnableHttps -ExternalHttpsUrl "https://trade.example.com/enterprise/".
If a handoff URL is already saved in the install, -ExternalHttpsUrl can be omitted. Old configurations without the persisted HTTPS mode remain local HTTP until this explicit switch.

Return an existing stopped install to local HTTP:
Run .\Stop-EnterpriseServer.ps1 first, then .\Start-EnterpriseServer.ps1 -DisableHttps.

Later start/stop:
Run .\Start-EnterpriseServer.ps1 or .\Stop-EnterpriseServer.ps1 from this folder. Start reuses a healthy process only when its HTTP/HTTPS behavior matches the saved configuration.

Use the same Windows account for service start/stop. The package does not deploy production TLS infrastructure or change DNS, firewall, proxy, or certificate trust settings.

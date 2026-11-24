TradeLoom Enterprise Server for Windows x64

First install, local-only HTTP:
1. Extract this ZIP into a new folder.
2. Open PowerShell in that folder and run .\Install-EnterpriseServer.ps1.
3. Create the first owner administrator when prompted. The installer creates a private PostgreSQL database and random service secrets under %LOCALAPPDATA%\TradeLoomEnterpriseServer. It does not save the administrator password.
4. On this Windows machine, connect the client to http://127.0.0.1:27417/enterprise/.

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

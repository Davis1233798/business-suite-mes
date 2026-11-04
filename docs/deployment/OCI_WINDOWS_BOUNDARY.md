# OCI Web and Windows client-server deployment

Web workspaces run on the existing OCI infrastructure. MES must coexist with the portfolio while retaining its own runtime account, rootless daemon, service, database volume, release root and deployment identity. The presence of `/srv/business-suite` is not a reason to reject a host. Access to its data or rootful Docker socket remains prohibited.

Windows desktop clients use their local Windows server and station-specific data directory. The desktop application must not silently fall back to an OCI database or share another station's local data.

Before changing the gateway, add remote tests proving that the portfolio directory may exist while MES identity, protected inbox ancestry, rootless socket ownership and fixed service namespace checks remain enforced. Replace the dedicated-host-only assertions and document a controlled private connection from central Caddy to the rootless MES upstream; Docker networks from different daemons cannot be joined. Preserve the existing public route until its replacement passes health, authorization, persistence and rollback acceptance.

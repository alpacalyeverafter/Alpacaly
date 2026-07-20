import { DEFAULT_RESOURCE_IDS } from "../domain/resources.js";

const CREATED_AT = "2026-07-19T00:00:00.000Z";

export const DEVELOPMENT_IDENTITIES = Object.freeze([
    Object.freeze({
        credential: "local-admin",
        administratorId: "administrator_development_platform_admin",
        externalIdentityId: "development:local-admin",
        displayName: "Local Platform Administrator",
        email: "local-admin@development.alpacaly.invalid",
        role: "ADMINISTRATOR",
        platformWide: true,
        barnId: null,
        createdAt: CREATED_AT
    }),
    Object.freeze({
        credential: "local-viewer",
        administratorId: "administrator_development_default_viewer",
        externalIdentityId: "development:local-viewer",
        displayName: "Local Barn Viewer",
        email: "local-viewer@development.alpacaly.invalid",
        role: "VIEWER",
        platformWide: false,
        barnId: DEFAULT_RESOURCE_IDS.barnId,
        createdAt: CREATED_AT
    }),
    Object.freeze({
        credential: "local-admin-secondary",
        administratorId: "administrator_development_platform_admin_secondary",
        externalIdentityId: "development:local-admin-secondary",
        displayName: "Secondary Platform Administrator",
        email: "local-admin-secondary@development.alpacaly.invalid",
        role: "ADMINISTRATOR",
        platformWide: true,
        barnId: null,
        createdAt: CREATED_AT
    }),
    Object.freeze({
        credential: "local-admin-tertiary",
        administratorId: "administrator_development_platform_admin_tertiary",
        externalIdentityId: "development:local-admin-tertiary",
        displayName: "Tertiary Platform Administrator",
        email: "local-admin-tertiary@development.alpacaly.invalid",
        role: "ADMINISTRATOR",
        platformWide: true,
        barnId: null,
        createdAt: CREATED_AT
    }),
    Object.freeze({
        credential: "local-welfare",
        administratorId: "administrator_development_welfare_operator",
        externalIdentityId: "development:local-welfare",
        displayName: "Local Welfare Operator",
        email: "local-welfare@development.alpacaly.invalid",
        role: "WELFARE_OPERATOR",
        platformWide: false,
        barnId: DEFAULT_RESOURCE_IDS.barnId,
        createdAt: CREATED_AT
    }),
    Object.freeze({
        credential: "local-hardware",
        administratorId: "administrator_development_hardware_operator",
        externalIdentityId: "development:local-hardware",
        displayName: "Local Hardware Operator",
        email: "local-hardware@development.alpacaly.invalid",
        role: "HARDWARE_OPERATOR",
        platformWide: false,
        barnId: DEFAULT_RESOURCE_IDS.barnId,
        createdAt: CREATED_AT
    })
]);

import { Auth0SupporterAuthProvider } from "./auth0-supporter-auth-provider.js";
import {
    DevelopmentSupporterAuthProvider
} from "./development-supporter-auth-provider.js";
import { SqliteSupporterAccountStore } from "./sqlite-supporter-account-store.js";
import { SupporterAccountService } from "./supporter-account-service.js";
import {
    UnconfiguredSupporterAuthProvider
} from "./unconfigured-supporter-auth-provider.js";

export function createSupporterAccountServices({
    eventEngine,
    feedCreditService,
    config,
    clock = eventEngine.clock,
    provider = null,
    idGenerator,
    tokenGenerator
}) {
    let selectedProvider = provider;
    if (!selectedProvider && config.supporterAuthProvider === "auth0") {
        selectedProvider = new Auth0SupporterAuthProvider({ config });
    }
    if (!selectedProvider && config.supporterAuthProvider === "development") {
        selectedProvider = new DevelopmentSupporterAuthProvider({ config, clock });
    }
    selectedProvider ||= new UnconfiguredSupporterAuthProvider({
        publicReturnUrl: config.supporterPublicReturnUrl
    });

    const store = new SqliteSupporterAccountStore({
        eventStore: eventEngine.eventStore
    });
    const service = new SupporterAccountService({
        provider: selectedProvider,
        store,
        feedCreditService,
        config,
        clock,
        ...(idGenerator ? { idGenerator } : {}),
        ...(tokenGenerator ? { tokenGenerator } : {})
    });

    return Object.freeze({
        provider: selectedProvider,
        middleware: selectedProvider.middleware(),
        store,
        service
    });
}

export { SupporterAccountService } from "./supporter-account-service.js";
export { SqliteSupporterAccountStore } from "./sqlite-supporter-account-store.js";

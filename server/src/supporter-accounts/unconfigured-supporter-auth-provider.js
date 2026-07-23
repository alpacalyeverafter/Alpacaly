import { ApplicationError } from "../errors/application-error.js";
import { SupporterAuthProvider } from "./supporter-auth-provider.js";

export class UnconfiguredSupporterAuthProvider extends SupporterAuthProvider {
    constructor({ publicReturnUrl }) {
        super();
        this.publicReturnUrl = publicReturnUrl;
        this.providerName = "unconfigured";
    }

    async login() {
        throw new ApplicationError(
            "Optional supporter accounts are not configured yet. Guest wallets remain available.",
            { code: "SUPPORTER_AUTHENTICATION_UNAVAILABLE", statusCode: 503 }
        );
    }

    async logout(_request, response) {
        response.redirect(303, this.publicReturnUrl);
    }
}

import { ApplicationError } from "../errors/application-error.js";
import { AuthProvider } from "./auth-provider.js";

export class UnconfiguredAuthProvider extends AuthProvider {
    async authenticate() {
        throw new ApplicationError(
            "Administrator authentication is not configured.",
            {
                code: "ADMINISTRATOR_AUTHENTICATION_REQUIRED",
                statusCode: 401
            }
        );
    }
}

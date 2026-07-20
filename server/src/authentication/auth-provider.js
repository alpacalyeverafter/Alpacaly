export class AuthProvider {
    async authenticate(_request) {
        throw new Error("AuthProvider.authenticate must be implemented.");
    }
}

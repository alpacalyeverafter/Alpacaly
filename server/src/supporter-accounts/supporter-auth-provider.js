export class SupporterAuthProvider {
    middleware() {
        return (_req, _res, next) => next();
    }

    async getIdentity(_request) {
        return null;
    }

    async login(_request, _response) {
        throw new Error("SupporterAuthProvider.login must be implemented.");
    }

    async logout(_request, _response) {
        throw new Error("SupporterAuthProvider.logout must be implemented.");
    }
}

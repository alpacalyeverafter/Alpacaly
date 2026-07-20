import { ApplicationError } from "../errors/application-error.js";

export class FeedEligibilityService {
    constructor({ eventStore }) {
        this.eventStore = eventStore;
    }

    requireEligibleContribution(contributionId) {
        const contribution = this.eventStore.getContribution(contributionId);
        if (!contribution) {
            throw new ApplicationError("Contribution not found.", {
                code: "CONTRIBUTION_NOT_FOUND",
                statusCode: 404
            });
        }

        const providerEvent = this.eventStore.getProviderEvent(
            contribution.providerEventId
        );
        if (!providerEvent || providerEvent.verificationStatus !== "VERIFIED") {
            throw new ApplicationError("Contribution has not been verified.", {
                code: "CONTRIBUTION_NOT_VERIFIED",
                statusCode: 409
            });
        }

        if (
            contribution.eligibilityStatus !== "ELIGIBLE"
            || contribution.feedQuantity < 1
        ) {
            throw new ApplicationError("Contribution is not eligible for feeding.", {
                code: "CONTRIBUTION_NOT_ELIGIBLE",
                statusCode: 409
            });
        }

        return { contribution, providerEvent };
    }
}

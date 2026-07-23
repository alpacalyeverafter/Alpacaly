function parseJson(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    return typeof value === "string" ? JSON.parse(value) : value;
}

function mapAccount(row) {
    return row ? {
        ...row,
        emailVerified: Boolean(row.emailVerified)
    } : null;
}

function mapEvent(row) {
    return row ? {
        ...row,
        eventSequence: Number(row.eventSequence),
        metadata: parseJson(row.metadataJson)
    } : null;
}

export class SqliteSupporterAccountStore {
    constructor({ eventStore }) {
        this.eventStore = eventStore;
        this.database = eventStore.database;
        this.statements = {
            insertAccount: this.database.prepare(`
                INSERT INTO SupporterAccounts (
                    accountId, providerName, externalIdentityId, emailNormalized,
                    emailVerified, displayName, status, sessionsValidAfter,
                    createdAt, updatedAt, deletedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (providerName, externalIdentityId) DO NOTHING
            `),
            selectAccountById: this.database.prepare(`
                SELECT * FROM SupporterAccounts WHERE accountId = ?
            `),
            selectAccountByIdentity: this.database.prepare(`
                SELECT * FROM SupporterAccounts
                WHERE providerName = ? AND externalIdentityId = ?
            `),
            refreshIdentity: this.database.prepare(`
                UPDATE SupporterAccounts
                SET emailNormalized = ?, emailVerified = ?, displayName = ?, updatedAt = ?
                WHERE accountId = ? AND status <> 'DELETED'
            `),
            listAccounts: this.database.prepare(`
                SELECT * FROM SupporterAccounts
                ORDER BY updatedAt DESC, accountId DESC LIMIT ?
            `),
            insertSession: this.database.prepare(`
                INSERT INTO SupporterSessions (
                    providerSessionId, accountId, authenticatedAt, lastSeenAt, revokedAt
                ) VALUES (?, ?, ?, ?, NULL)
                ON CONFLICT (providerSessionId) DO UPDATE SET
                    lastSeenAt = excluded.lastSeenAt
                WHERE SupporterSessions.accountId = excluded.accountId
                  AND SupporterSessions.revokedAt IS NULL
            `),
            selectSession: this.database.prepare(`
                SELECT * FROM SupporterSessions WHERE providerSessionId = ?
            `),
            revokeSessions: this.database.prepare(`
                UPDATE SupporterSessions SET revokedAt = ?
                WHERE accountId = ? AND revokedAt IS NULL
            `),
            setSessionsValidAfter: this.database.prepare(`
                UPDATE SupporterAccounts SET sessionsValidAfter = ?, updatedAt = ?
                WHERE accountId = ? AND status = 'ACTIVE'
            `),
            selectLinksByAccount: this.database.prepare(`
                SELECT * FROM SupporterWalletLinks
                WHERE accountId = ? AND status = 'ACTIVE'
                ORDER BY linkedAt ASC, linkId ASC
            `),
            selectLinkByWallet: this.database.prepare(`
                SELECT * FROM SupporterWalletLinks
                WHERE walletId = ? AND status = 'ACTIVE'
            `),
            selectLinkByClient: this.database.prepare(`
                SELECT * FROM SupporterWalletLinks
                WHERE accountId = ? AND clientRequestId = ?
            `),
            selectWalletByToken: this.database.prepare(`
                SELECT * FROM CreditWallets WHERE recoveryTokenHash = ?
            `),
            selectWalletById: this.database.prepare(`
                SELECT * FROM CreditWallets WHERE walletId = ?
            `),
            insertLink: this.database.prepare(`
                INSERT INTO SupporterWalletLinks (
                    linkId, accountId, walletId, clientRequestId, status,
                    linkedAt, releasedAt, releaseReason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `),
            revokeWalletRecovery: this.database.prepare(`
                UPDATE CreditWallets SET recoveryTokenHash = ?, updatedAt = ?
                WHERE walletId = ? AND recoveryTokenHash = ? AND status = 'ACTIVE'
            `),
            releaseLink: this.database.prepare(`
                UPDATE SupporterWalletLinks
                SET status = 'RELEASED', releasedAt = ?, releaseReason = ?
                WHERE linkId = ? AND status = 'ACTIVE'
            `),
            rotateWalletRecovery: this.database.prepare(`
                UPDATE CreditWallets SET recoveryTokenHash = ?, updatedAt = ?
                WHERE walletId = ? AND status = 'ACTIVE'
            `),
            deleteAccount: this.database.prepare(`
                UPDATE SupporterAccounts
                SET providerName = 'deleted',
                    externalIdentityId = 'deleted:' || accountId,
                    emailNormalized = NULL, emailVerified = 0,
                    displayName = 'Deleted supporter', status = 'DELETED',
                    sessionsValidAfter = ?, updatedAt = ?, deletedAt = ?
                WHERE accountId = ? AND status = 'ACTIVE'
            `),
            setAccountStatus: this.database.prepare(`
                UPDATE SupporterAccounts SET status = ?, updatedAt = ?
                WHERE accountId = ? AND status <> 'DELETED'
            `),
            insertEvent: this.database.prepare(`
                INSERT INTO SupporterAccountEvents (
                    eventId, accountId, walletId, eventType, actorType,
                    actorReference, requestId, reason, metadataJson, createdAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectEventsByAccount: this.database.prepare(`
                SELECT * FROM SupporterAccountEvents WHERE accountId = ?
                ORDER BY eventSequence DESC LIMIT ?
            `),
            listEvents: this.database.prepare(`
                SELECT * FROM SupporterAccountEvents
                ORDER BY eventSequence DESC LIMIT ?
            `)
        };
    }

    upsertIdentity(account, createdEvent) {
        return this.eventStore.transaction(() => {
            const inserted = this.statements.insertAccount.run(
                account.accountId,
                account.providerName,
                account.externalIdentityId,
                account.emailNormalized,
                account.emailVerified ? 1 : 0,
                account.displayName,
                account.status,
                account.sessionsValidAfter,
                account.createdAt,
                account.updatedAt,
                account.deletedAt
            );
            let persisted = this.getAccountByIdentity(
                account.providerName,
                account.externalIdentityId
            );
            if (Number(inserted.changes) === 1) {
                this.insertEvent(createdEvent);
                return { account: persisted, created: true };
            }
            if (persisted?.status !== "DELETED") {
                this.statements.refreshIdentity.run(
                    account.emailNormalized,
                    account.emailVerified ? 1 : 0,
                    account.displayName,
                    account.updatedAt,
                    persisted.accountId
                );
                persisted = this.getAccount(persisted.accountId);
            }
            return { account: persisted, created: false };
        });
    }

    getAccount(accountId) {
        return mapAccount(this.statements.selectAccountById.get(accountId));
    }

    getAccountByIdentity(providerName, externalIdentityId) {
        return mapAccount(this.statements.selectAccountByIdentity.get(
            providerName,
            externalIdentityId
        ));
    }

    recordSession(session, event) {
        return this.eventStore.transaction(() => {
            const existing = this.statements.selectSession.get(session.providerSessionId);
            this.statements.insertSession.run(
                session.providerSessionId,
                session.accountId,
                session.authenticatedAt,
                session.lastSeenAt
            );
            const persisted = this.statements.selectSession.get(session.providerSessionId);
            if (!existing && persisted) {
                this.insertEvent(event);
            }
            return persisted ? { ...persisted } : null;
        });
    }

    linkWallet({ accountId, clientRequestId, tokenHash, replacementHash, link, event }) {
        return this.eventStore.transaction(() => {
            const priorRequest = this.statements.selectLinkByClient.get(
                accountId,
                clientRequestId
            );
            if (priorRequest) {
                return {
                    link: { ...priorRequest },
                    wallet: { ...this.statements.selectWalletById.get(priorRequest.walletId) },
                    duplicate: true
                };
            }
            const wallet = this.statements.selectWalletByToken.get(tokenHash);
            if (!wallet || wallet.status !== "ACTIVE") {
                const error = new Error("The wallet ownership proof is invalid.");
                error.code = "SUPPORTER_WALLET_PROOF_INVALID";
                throw error;
            }
            const existing = this.statements.selectLinkByWallet.get(wallet.walletId);
            if (existing) {
                const error = new Error("The wallet is already protected by an account.");
                error.code = "SUPPORTER_WALLET_ALREADY_LINKED";
                throw error;
            }
            this.statements.insertLink.run(
                link.linkId,
                link.accountId,
                link.walletId,
                link.clientRequestId,
                link.status,
                link.linkedAt,
                link.releasedAt,
                link.releaseReason
            );
            const rotated = this.statements.revokeWalletRecovery.run(
                replacementHash,
                link.linkedAt,
                wallet.walletId,
                tokenHash
            );
            if (Number(rotated.changes) !== 1) {
                throw new Error("The wallet recovery credential could not be revoked safely.");
            }
            this.insertEvent(event);
            return {
                link: { ...this.statements.selectLinkByClient.get(
                    accountId,
                    clientRequestId
                ) },
                wallet: { ...this.statements.selectWalletById.get(wallet.walletId) },
                duplicate: false
            };
        });
    }

    listWalletLinks(accountId) {
        return this.statements.selectLinksByAccount.all(accountId).map(row => ({ ...row }));
    }

    getWalletLink(accountId, walletId) {
        const link = this.statements.selectLinkByWallet.get(walletId);
        return link?.accountId === accountId ? { ...link } : null;
    }

    getWalletLinkByClientRequest(accountId, clientRequestId) {
        const link = this.statements.selectLinkByClient.get(accountId, clientRequestId);
        return link ? { ...link } : null;
    }

    revokeAllSessions(accountId, timestamp, event) {
        return this.eventStore.transaction(() => {
            this.statements.setSessionsValidAfter.run(timestamp, timestamp, accountId);
            this.statements.revokeSessions.run(timestamp, accountId);
            this.insertEvent(event);
            return this.getAccount(accountId);
        });
    }

    deleteAccount(accountId, recoveryCredentials, timestamp, event) {
        return this.eventStore.transaction(() => {
            const account = this.getAccount(accountId);
            if (!account || account.status !== "ACTIVE") {
                return { account, deleted: false };
            }
            for (const item of recoveryCredentials) {
                this.statements.rotateWalletRecovery.run(
                    item.tokenHash,
                    timestamp,
                    item.walletId
                );
                this.statements.releaseLink.run(
                    timestamp,
                    "ACCOUNT_DELETED_WALLET_RETURNED_TO_GUEST",
                    item.linkId
                );
            }
            this.statements.revokeSessions.run(timestamp, accountId);
            this.statements.deleteAccount.run(
                timestamp,
                timestamp,
                timestamp,
                accountId
            );
            this.insertEvent(event);
            return { account: this.getAccount(accountId), deleted: true };
        });
    }

    setAccountStatus(accountId, status, timestamp, event) {
        return this.eventStore.transaction(() => {
            if (status !== "ACTIVE") {
                // Invalidate sessions that have not contacted Alpacaly yet as
                // well as the provider sessions already recorded locally.
                this.statements.setSessionsValidAfter.run(
                    timestamp,
                    timestamp,
                    accountId
                );
                this.statements.revokeSessions.run(timestamp, accountId);
            }
            this.statements.setAccountStatus.run(status, timestamp, accountId);
            this.insertEvent(event);
            return this.getAccount(accountId);
        });
    }

    revokeAccountSessions(accountId, timestamp, event) {
        return this.eventStore.transaction(() => {
            this.statements.setSessionsValidAfter.run(timestamp, timestamp, accountId);
            this.statements.revokeSessions.run(timestamp, accountId);
            this.insertEvent(event);
            return this.getAccount(accountId);
        });
    }

    getWallet(walletId) {
        const wallet = this.statements.selectWalletById.get(walletId);
        return wallet ? { ...wallet } : null;
    }

    getWalletByTokenHash(tokenHash) {
        const wallet = this.statements.selectWalletByToken.get(tokenHash);
        return wallet ? { ...wallet } : null;
    }

    recordEvent(event) {
        this.eventStore.transaction(() => this.insertEvent(event));
    }

    insertEvent(event) {
        this.statements.insertEvent.run(
            event.eventId,
            event.accountId,
            event.walletId,
            event.eventType,
            event.actorType,
            event.actorReference,
            event.requestId,
            event.reason,
            JSON.stringify(event.metadata ?? null),
            event.createdAt
        );
    }

    listEventsForAccount(accountId, limit = 100) {
        return this.statements.selectEventsByAccount
            .all(accountId, Math.min(500, Math.max(1, Number(limit) || 100)))
            .map(mapEvent);
    }

    getAdministratorView(limit = 100) {
        const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
        return {
            accounts: this.statements.listAccounts.all(safeLimit).map(mapAccount),
            events: this.statements.listEvents.all(safeLimit).map(mapEvent)
        };
    }
}

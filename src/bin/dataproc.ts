import * as orm from 'typeorm';
import { JournalReader, GameRegion, JournalMultiProcessor, JournalEventKind, JournalEventNewLobby, JournalEventCloseLobby, GameLobbyStatus, JournalEventUpdateLobbySnapshot, JournalEventUpdateLobbyList, GameLobbyDesc, JournalEventUpdateLobbySlots, JournalEventBase } from '../gametracker';
import { JournalFeed } from '../journal/feed';
import { S2GameLobby } from '../entity/S2GameLobby';
import { S2Region } from '../entity/S2Region';
import { logger, logIt, setupFileLogger } from '../logger';
import { S2DocumentVersion } from '../entity/S2DocumentVersion';
import { S2Document, S2DocumentType } from '../entity/S2Document';
import { S2GameLobbySlot, S2GameLobbySlotKind } from '../entity/S2GameLobbySlot';
import { SysFeedProvider } from '../entity/SysFeedProvider';
import { sleep, execAsync } from '../helpers';
import { DataLobbyCreate, LobbyPvExSlotKind } from '../journal/decoder';
import { SysFeedPosition } from '../entity/SysFeedPosition';
import { S2MapCategory } from '../entity/S2MapCategory';
import { S2Profile } from '../entity/S2Profile';
import { S2GameLobbyPlayerJoin } from '../entity/S2GameLobbyPlayerJoin';

function isErrDuplicateEntry(err: Error) {
    if (!(err instanceof orm.QueryFailedError)) return;
    return (<any>err).code === 'ER_DUP_ENTRY';
}

function throwErrIfNotDuplicateEntry(err: Error) {
    if (isErrDuplicateEntry(err)) return;
    throw err;
}

class DataProc {
    protected conn: orm.Connection;
    protected em: orm.EntityManager;
    protected journalProc = new JournalMultiProcessor(this.region);
    protected s2region: S2Region;
    protected feedProviders = new Map<string, SysFeedProvider>();
    protected closed = false;

    protected docVerCache = new Map<string, number>();
    protected lobbiesCache = new Map<number, S2GameLobby>();
    protected profilesCache = new Map<string, S2Profile>();

    protected lobbiesReopenCandidates = new Set();

    constructor(public readonly region: GameRegion) {
    }

    @logIt()
    async open() {
        this.conn = await orm.createConnection();
        this.em = this.conn.createEntityManager();

        this.s2region = await this.conn.getRepository(S2Region).findOne({
            where: {
                id: this.region,
            },
        });
        this.feedProviders = new Map((await this.conn.getRepository(SysFeedProvider).find({
            where: {
                region: this.s2region,
                enabled: true,
            },
        })).map(x => [`${x.name}-${x.region.code}`, x]));

        for (const [name, item] of this.feedProviders) {
            const feed = new JournalFeed(`data/lbstream/${name}`, {
                session: item.position.resumingFile,
                // offset: item.position.resumingOffset,
                offset: 0,
            });
            this.journalProc.addFeedSource(feed);
        }
    }

    async close() {
        if (this.closed) {
            logger.error(`forcing termination..`);
            await sleep(1000);
            process.exit(1);
        }
        this.closed = true;
        await this.journalProc.close();
    }

    async work() {
        while (!this.closed) {
            const ev = await this.journalProc.proceed();
            if (!ev) break;

            const feedProvider = this.feedProviders.get(ev.feedName);
            const feedPos = feedProvider.position;
            if (ev.feedCursor.session <= feedPos.storageFile && ev.feedCursor.offset < feedPos.storageOffset) {
                continue;
            }

            switch (ev.kind) {
                case JournalEventKind.NewLobby: {
                    await this.onNewLobby(ev);
                    break;
                }
                case JournalEventKind.CloseLobby: {
                    await this.onCloseLobby(ev);
                    await this.updateResumingOffset(ev);
                    break;
                }
                case JournalEventKind.UpdateLobbySnapshot: {
                    await this.onUpdateLobbySnapshot(ev);
                    break;
                }
                case JournalEventKind.UpdateLobbySlots: {
                    await this.onUpdateLobbySlots(ev);
                    break;
                }
                case JournalEventKind.UpdateLobbyList: {
                    await this.onUpdateLobbyList(ev);
                    break;
                }
            }
        }
        await this.conn.close();
    }

    protected async updateStorageOffset(ev: JournalEventBase) {
        const feedProvider = this.feedProviders.get(ev.feedName);
        const feedPos = feedProvider.position;

        if (feedPos.storageFile < ev.feedCursor.session || feedPos.storageOffset < ev.feedCursor.offset) {
            feedPos.storageFile = ev.feedCursor.session;
            feedPos.storageOffset = ev.feedCursor.offset;
            await this.em.getRepository(SysFeedPosition).update(feedProvider.id, {
                storageFile: ev.feedCursor.session,
                storageOffset: ev.feedCursor.offset,
            });
        }
    }

    protected async updateResumingOffset(ev: JournalEventBase) {
        const feedProvider = this.feedProviders.get(ev.feedName);
        const feedPos = feedProvider.position;

        const cursorResume = this.journalProc.gtracks.get(ev.feedName).cursorResumePointer;
        if (feedPos.resumingFile < cursorResume.session || feedPos.resumingOffset < cursorResume.offset) {
            feedPos.resumingFile = cursorResume.session;
            feedPos.resumingOffset = cursorResume.offset;
            await this.em.getRepository(SysFeedPosition).update(feedProvider.id, {
                resumingFile: cursorResume.session,
                resumingOffset: cursorResume.offset,
            });
        }
    }

    protected async getLobby(lobby: GameLobbyDesc) {
        let s2lobby = this.lobbiesCache.get(lobby.initInfo.lobbyId);
        if (!s2lobby) {
            s2lobby = await this.em.getRepository(S2GameLobby).findOneOrFail({
                bnetBucketId: lobby.initInfo.bucketId,
                bnetRecordId: lobby.initInfo.lobbyId,
            }, {
                relations: ['slots', 'slots.profile', 'slots.joinInfo'],
            });
            this.lobbiesCache.set(lobby.initInfo.lobbyId, s2lobby);

            // assign profile to corresponding joinInfo on human slots manually
            // doing it directly from the typeorm could likely result in circular dependency issues
            s2lobby.slots.forEach(slot => {
                if (!slot.joinInfo) return;
                slot.joinInfo.profile = slot.profile;
            });
        }
        return s2lobby;
    }

    protected async updateLobby(s2lobby: S2GameLobby, updateData: Partial<S2GameLobby>) {
        Object.assign(s2lobby, updateData);
        await this.em.getRepository(S2GameLobby).update(s2lobby.id, updateData);
    }

    protected async doUpdateSlots(s2lobby: S2GameLobby, lobbyData: GameLobbyDesc, ev: JournalEventBase) {
        if (!lobbyData.slots || lobbyData.slotsPreviewUpdatedAt <= s2lobby.slotsUpdatedAt) return;

        const slotKindMap = {
            [LobbyPvExSlotKind.Computer]: S2GameLobbySlotKind.AI,
            [LobbyPvExSlotKind.Open]: S2GameLobbySlotKind.Open,
            [LobbyPvExSlotKind.Human]: S2GameLobbySlotKind.Human,
        };

        if (s2lobby.slots.length !== lobbyData.slots.length) {
            if (s2lobby.slots.length > 0) {
                logger.warn(`updated available slots ${this.s2region.code}#${s2lobby.bnetRecordId} prevSlotCount=${s2lobby.slots.length} newSlotCount=${lobbyData.slots.length}`, s2lobby.slots, lobbyData.slots, ev);
            }
            if (s2lobby.slots.length > lobbyData.slots.length) {
                const removedSlots = s2lobby.slots.splice(lobbyData.slots.length);
                const removedOccupiedSlots = removedSlots.filter(s2slot => s2slot.joinInfo);
                if (removedOccupiedSlots.length) {
                    logger.warn(`occupied slots have been removed?!`, ev, removedOccupiedSlots);
                    await this.conn.getRepository(S2GameLobbyPlayerJoin).update(
                        removedOccupiedSlots.map(s2slot => s2slot.joinInfo.id),
                        {
                            leftAt: lobbyData.slotsPreviewUpdatedAt,
                        }
                    );
                }
                await this.conn.getRepository(S2GameLobbySlot).delete(removedSlots.map(x => x.id));
            }
            else {
                const addedSlots = lobbyData.slots.map((infoSlot, idx) => {
                    if (idx < s2lobby.slots.length) {
                        return void 0;
                    }
                    const s2slot = new S2GameLobbySlot();
                    Object.assign(s2slot, {
                        lobby: s2lobby,
                        slotNumber: idx + 1,
                        team: infoSlot.team,
                        kind: S2GameLobbySlotKind.Open,
                    } as S2GameLobbySlot);
                    return s2slot;
                }).filter(x => x !== void 0);

                // bulk insert is fucked in current version of typeorm
                // https://github.com/typeorm/typeorm/issues/5973
                // https://github.com/typeorm/typeorm/issues/6025
                // const result = await this.conn.getRepository(S2GameLobbySlot).insert(addedSlots);

                // use multiple quries instead
                await Promise.all(addedSlots.map(async x => this.conn.getRepository(S2GameLobbySlot).insert(x)));

                s2lobby.slots.push(...addedSlots);
            }
        }
        else {
            const affectedSlots = lobbyData.slots.filter((infoSlot, idx) => {
                const s2slot = s2lobby.slots[idx];
                if (slotKindMap[infoSlot.kind] !== s2slot.kind) return true;
                if (infoSlot.team !== s2slot.team) return true;
                if (infoSlot.name !== s2slot.name) return true;
                if (infoSlot.profile?.realmId !== s2slot.profile?.realmId || infoSlot.profile?.profileId !== s2slot.profile?.profileId) return true;
            });
            if (!affectedSlots.length) return;
        }

        const newS2profiles = await Promise.all(lobbyData.slots.map(slot => {
            if (!slot.profile) return null;
            return this.fetchOrCreateProfile(slot.profile, lobbyData.slotsPreviewUpdatedAt);
        }));

        await this.conn.transaction(async tsManager => {
            const playerLeaveInfo = new Map<string, S2GameLobbyPlayerJoin>();

            const updatedSlots = await Promise.all(lobbyData.slots.map(async (infoSlot, idx) => {
                const s2slot = s2lobby.slots[idx];
                if (idx !== (s2slot.slotNumber - 1)) {
                    logger.error('wtf2', idx, s2slot.slotNumber, s2slot, infoSlot, s2lobby, lobbyData);
                    throw new Error('wtf2');
                }
                const newS2SlotKind = slotKindMap[infoSlot.kind];
                if (newS2SlotKind !== s2slot.kind || infoSlot.name !== s2slot.name || infoSlot.team !== s2slot.team) {
                    if (
                        s2slot.joinInfo &&
                        (
                            !infoSlot.profile ||
                            infoSlot.profile.realmId !== s2slot.joinInfo.profile.realmId ||
                            infoSlot.profile.profileId !== s2slot.joinInfo.profile.profileId
                        )
                    ) {
                        playerLeaveInfo.set(`${s2slot.joinInfo.profile.realmId}-${s2slot.joinInfo.profile.profileId}`, s2slot.joinInfo);
                        s2slot.joinInfo = null;
                    }

                    if (!s2slot.joinInfo && newS2profiles[idx]) {
                        const pkey = `${newS2profiles[idx].realmId}-${newS2profiles[idx].profileId}`;
                        s2slot.joinInfo = playerLeaveInfo.get(pkey);
                        if (s2slot.joinInfo) {
                            playerLeaveInfo.delete(pkey);
                        }
                        else {
                            const joinInfoSlotIdx = s2lobby.slots.findIndex(x => x.joinInfo && x.joinInfo.profile.realmId === newS2profiles[idx].realmId && x.joinInfo.profile.profileId === newS2profiles[idx].profileId);
                            if (joinInfoSlotIdx !== -1) {
                                s2slot.joinInfo = s2lobby.slots[joinInfoSlotIdx].joinInfo;
                                s2lobby.slots[joinInfoSlotIdx].joinInfo = null;
                            }
                            else {
                                s2slot.joinInfo = new S2GameLobbyPlayerJoin();
                                s2slot.joinInfo.lobby = s2lobby;
                                s2slot.joinInfo.profile = newS2profiles[idx];
                                s2slot.joinInfo.joinedAt = lobbyData.slotsPreviewUpdatedAt;
                                await tsManager.getRepository(S2GameLobbyPlayerJoin).insert(s2slot.joinInfo);
                            }
                        }
                    }

                    const changedData: Partial<S2GameLobbySlot> = {
                        team: infoSlot.team,
                        kind: newS2SlotKind,
                        profile: newS2profiles[idx],
                        name: infoSlot.name,
                        joinInfo: s2slot.joinInfo,
                    };
                    Object.assign(s2slot, changedData);
                    return tsManager.getRepository(S2GameLobbySlot).update(s2slot.id, changedData);
                }
            }));

            if (playerLeaveInfo.size) {
                const pks = Array.from(playerLeaveInfo.values()).map(x => x.id);
                await tsManager.getRepository(S2GameLobbyPlayerJoin).update(pks, {
                    leftAt: lobbyData.slotsPreviewUpdatedAt,
                });
            }

            s2lobby.slotsUpdatedAt = lobbyData.slotsPreviewUpdatedAt;
            await tsManager.getRepository(S2GameLobby).update(s2lobby.id, {
                slotsUpdatedAt: lobbyData.slotsPreviewUpdatedAt,
            });
        });

        return true;
    }

    async fetchOrCreateProfile(infoProfile: Pick<S2Profile, 'regionId' | 'realmId' | 'profileId' | 'name' | 'discriminator'>, updatedAt: Date) {
        const profKey = `${infoProfile.realmId}-${infoProfile.profileId}`;
        let s2profile = this.profilesCache.get(profKey);
        if (!s2profile) {
            s2profile = await this.conn.getRepository(S2Profile).findOne({
                where: {
                    regionId: infoProfile.regionId,
                    realmId: infoProfile.realmId,
                    profileId: infoProfile.profileId,
                },
            });
            if (!s2profile) {
                s2profile = new S2Profile();
                s2profile.updatedAt = updatedAt;
                Object.assign(s2profile, infoProfile);
                await this.conn.getRepository(S2Profile).insert(s2profile);
            }
            this.profilesCache.set(profKey, s2profile);
        }

        if (
            (s2profile.name !== infoProfile.name || s2profile.discriminator !== infoProfile.discriminator) &&
            (s2profile.updatedAt === null || s2profile.updatedAt < updatedAt)
        ) {
            logger.verbose(`Updating profile name from ${s2profile.name}#${s2profile.discriminator} to ${infoProfile.name}#${infoProfile.discriminator}`);
            const updateData: Partial<S2Profile> = {
                name: infoProfile.name,
                discriminator: infoProfile.discriminator,
                updatedAt: updatedAt,
            };
            Object.assign(s2profile, updateData);
            await this.conn.getRepository(S2Profile).update(s2profile, updateData);
        }

        return s2profile;
    }

    async fetchOrCreateDocumentVersion(infoDoc: S2Document, infoDocVer: S2DocumentVersion, opts: { categoryName?: string } = {}) {
        if (!infoDoc.bnetId) return null;
        const docKey = `${infoDoc.bnetId}/${infoDocVer.majorVersion}.${infoDocVer.minorVersion}`;
        let docVersionId = this.docVerCache.get(docKey);
        if (!docVersionId) {
            let s2doc = await this.em.getRepository(S2Document).findOne({
                where: {
                    region: this.s2region,
                    bnetId: infoDoc.bnetId,
                },
            });
            if (!s2doc) {
                s2doc = Object.assign({}, infoDoc);
                s2doc.region = this.s2region;
                s2doc.currentMajorVersion = infoDocVer.majorVersion;
                s2doc.currentMinorVersion = infoDocVer.minorVersion;
                if (opts.categoryName) {
                    let s2category = await this.em.getRepository(S2MapCategory).findOne({
                        where: {
                            name: opts.categoryName,
                        },
                    });
                    if (!s2category) {
                        s2category = new S2MapCategory();
                        s2category.name = opts.categoryName;
                        await this.em.getRepository(S2MapCategory).save(s2category);
                    }
                    s2doc.category = s2category;
                }
                await this.em.getRepository(S2Document).save(s2doc);
            }
            else {
                if (
                    (s2doc.currentMajorVersion === null || s2doc.currentMinorVersion === null) ||
                    (infoDocVer.majorVersion >= s2doc.currentMajorVersion || infoDocVer.minorVersion >= s2doc.currentMinorVersion)
                ) {
                    s2doc.currentMajorVersion = infoDocVer.majorVersion;
                    s2doc.currentMinorVersion = infoDocVer.minorVersion;
                }
                if (infoDoc.name.length && !s2doc.name.length) {
                    s2doc.name = infoDoc.name;
                }
                await this.em.getRepository(S2Document).save(s2doc);
            }

            let s2docVer = await this.em.getRepository(S2DocumentVersion).findOne({
                where: {
                    document: s2doc,
                    majorVersion: infoDocVer.majorVersion,
                    minorVersion: infoDocVer.minorVersion,
                },
            });
            if (!s2docVer) {
                s2docVer = new S2DocumentVersion();
                s2docVer.document = s2doc;
                s2docVer.majorVersion = infoDocVer.majorVersion;
                s2docVer.minorVersion = infoDocVer.minorVersion;
                s2docVer.headerHash = null;
                s2docVer.documentHash = null;
                s2docVer.iconHash = infoDocVer.iconHash;
                s2docVer = await this.em.getRepository(S2DocumentVersion).save(s2docVer);
            }

            docVersionId = s2docVer.id;
            this.docVerCache.set(docKey, docVersionId);
        }
        return docVersionId;
    }

    async onNewLobby(ev: JournalEventNewLobby) {
        const info = ev.lobby.initInfo;

        const mapDocVer = await this.fetchOrCreateDocumentVersion(
            {
                bnetId: info.mapHandle[0],
                type: S2DocumentType.Map,
                isArcade: info.isArcade,
                name: info.mapName,
            } as S2Document,
            {
                iconHash: info.mapIcon.substr(0, 64),
                minorVersion: info.mapMinorVersion,
                majorVersion: info.mapMajorVersion,
            } as S2DocumentVersion,
            {
                categoryName: info.mapVariantCategory,
            },
        );
        const extModDocVer = await this.fetchOrCreateDocumentVersion(
            {
                bnetId: info.extModHandle[0],
                name: info.extModName,
                type: S2DocumentType.ExtensionMod,
            } as S2Document,
            {
                minorVersion: info.extModMinorVersion,
                majorVersion: info.extModMajorVersion,
            } as S2DocumentVersion,
        );
        const multiModDocVer = await this.fetchOrCreateDocumentVersion(
            {
                bnetId: info.multiModHandle[0],
                name: info.multiModName,
                type: S2DocumentType.ExtensionMod,
            } as S2Document,
            {
                minorVersion: info.multiModMinorVersion,
                majorVersion: info.multiModMajorVersion,
            } as S2DocumentVersion,
        );

        let s2lobby = new S2GameLobby();
        Object.assign(s2lobby, <S2GameLobby>{
            region: this.s2region,
            bnetBucketId: info.bucketId,
            bnetRecordId: info.lobbyId,
            createdAt: ev.lobby.createdAt,
            snapshotUpdatedAt: ev.lobby.snapshotUpdatedAt,

            mapBnetId: info.mapHandle[0],
            mapMajorVersion: info.mapMajorVersion,
            mapMinorVersion: info.mapMinorVersion,

            extModBnetId: info.extModHandle[0] !== 0 ? info.extModHandle[0] : null,
            extModMajorVersion: info.extModHandle[0] !== 0 ? info.extModMajorVersion : null,
            extModMinorVersion: info.extModHandle[0] !== 0 ? info.extModMinorVersion : null,

            multiModBnetId: info.multiModHandle[0] !== 0 ? info.multiModHandle[0] : null,
            multiModMajorVersion: info.multiModHandle[0] !== 0 ? info.multiModMajorVersion : null,
            multiModMinorVersion: info.multiModHandle[0] !== 0 ? info.multiModMinorVersion : null,

            mapDocumentVersion: mapDocVer as any,
            extModDocumentVersion: extModDocVer as any,
            multiModDocumentVersion: multiModDocVer as any,

            mapVariantIndex: info.mapVariantIndex,
            mapVariantMode: info.mapVariantMode,

            lobbyTitle: ev.lobby.lobbyName,
            hostName: ev.lobby.hostName,
            slotsHumansTaken: ev.lobby.slotsHumansTaken,
            slotsHumansTotal: ev.lobby.slotsHumansTotal,
        });

        try {
            await this.em.getRepository(S2GameLobby).insert(s2lobby);
            s2lobby.slots = [];
            this.lobbiesCache.set(info.lobbyId, s2lobby);
            logger.info(`NEW src=${ev.feedName} ${this.s2region.code}#${s2lobby.bnetRecordId} map="${info.mapName}"`);
        }
        catch (err) {
            if (isErrDuplicateEntry(err)) {
                s2lobby = await this.getLobby(ev.lobby);
                if (s2lobby.status !== GameLobbyStatus.Open) {
                    const snapshotTimeDiff = ev.lobby.snapshotUpdatedAt.getTime() - s2lobby.snapshotUpdatedAt.getTime();
                    this.lobbiesReopenCandidates.add(s2lobby.id);
                    logger.verbose(`src=${ev.feedName} ${this.s2region.code}#${s2lobby.bnetRecordId} lobby reappeared`, [
                        [s2lobby.createdAt, ev.lobby.createdAt],
                        [s2lobby.closedAt, ev.lobby.closedAt],
                        [s2lobby.snapshotUpdatedAt, ev.lobby.snapshotUpdatedAt, snapshotTimeDiff],
                    ]);
                }
            }
            else {
                throw err;
            }
        }
    }

    async onCloseLobby(ev: JournalEventCloseLobby) {
        const s2lobby = await this.getLobby(ev.lobby);

        // discard candidate and exit without altering any data
        if (this.lobbiesReopenCandidates.has(s2lobby.id)) {
            this.lobbiesReopenCandidates.delete(s2lobby.id);
            this.lobbiesCache.delete(s2lobby.id);
            return;
        }

        // verify if anything has changed in a closed lobby which has reappeared
        if (s2lobby.status !== GameLobbyStatus.Open) {
            if (s2lobby.status === GameLobbyStatus.Unknown && ev.lobby.status !== GameLobbyStatus.Unknown) {
                logger.warn(`src=${ev.feedName} ${this.s2region.code}#${s2lobby.bnetRecordId} reopening lobby with status=${s2lobby.status}`);
                await this.updateLobby(s2lobby, {
                    closedAt: null,
                    status: GameLobbyStatus.Open,

                    snapshotUpdatedAt: ev.lobby.snapshotUpdatedAt,
                    hostName: ev.lobby.hostName,
                    lobbyTitle: ev.lobby.lobbyName,
                    slotsHumansTaken: ev.lobby.slotsHumansTaken,
                    slotsHumansTotal: ev.lobby.slotsHumansTotal,
                });
            }
            else {
                const closeDiff = s2lobby.closedAt.getTime() - ev.lobby.closedAt.getTime();
                if (closeDiff !== 0) {
                    logger.verbose(`src=${ev.feedName} ${this.s2region.code}#${s2lobby.bnetRecordId} attempted to close lobby which has its state already determined`);
                }
                this.lobbiesCache.delete(ev.lobby.initInfo.lobbyId);
                return;
            }
        }

        await this.doUpdateSlots(s2lobby, ev.lobby, ev);
        if (
            (ev.lobby.status !== GameLobbyStatus.Started && s2lobby.slots.length)
        ) {
            await this.em.getRepository(S2GameLobbyPlayerJoin).createQueryBuilder()
                .update()
                .set({ leftAt: ev.lobby.closedAt })
                .andWhere('leftAt IS NULL')
                .andWhere('lobby = :lobbyId')
                .setParameter('lobbyId', s2lobby.id)
                .execute()
            ;
            await this.em.getRepository(S2GameLobbySlot).createQueryBuilder()
                .delete()
                .andWhere('lobby = :lobbyId')
                .setParameter('lobbyId', s2lobby.id)
                .execute()
            ;
        }

        await this.updateLobby(s2lobby, {
            closedAt: ev.lobby.closedAt,
            status: ev.lobby.status,
        });
        this.lobbiesCache.delete(ev.lobby.initInfo.lobbyId);
        logger.info(`CLOSED src=${ev.feedName} ${this.s2region.code}#${ev.lobby.initInfo.lobbyId} ${ev.lobby.closedAt.toISOString()} status=${ev.lobby.status}`);
    }

    async onUpdateLobbySnapshot(ev: JournalEventUpdateLobbySnapshot) {
        const s2lobby = await this.getLobby(ev.lobby);
        if (s2lobby.snapshotUpdatedAt > ev.lobby.snapshotUpdatedAt) return;

        // do not update data from snapshots on *closed* lobbies - it may happen when data feed from one of the runners arrives too late
        // thus it needs to be processed retroactively to fill eventual gaps in what has been already stored in database
        // wait till the Close event to determine if provided data actually affects anything
        if (s2lobby.status !== GameLobbyStatus.Open) {
            return;
        }

        await this.updateLobby(s2lobby, {
            lobbyTitle: ev.lobby.lobbyName,
            hostName: ev.lobby.hostName,
            slotsHumansTaken: ev.lobby.slotsHumansTaken,
            slotsHumansTotal: ev.lobby.slotsHumansTotal,
        });
    }

    async onUpdateLobbySlots(ev: JournalEventUpdateLobbySlots) {
        const s2lobby = await this.getLobby(ev.lobby);
        const changed = await this.doUpdateSlots(s2lobby, ev.lobby, ev);
        if (changed) {
            logger.info(`slots updated, src=${ev.feedName} ${this.s2region.code}#${s2lobby.bnetRecordId}`);

            if (this.lobbiesReopenCandidates.has(s2lobby.id)) {
                logger.info(`src=${ev.feedName} ${this.s2region.code}#${s2lobby.bnetRecordId} lobby reopened`);
                await this.updateLobby(s2lobby, {
                    status: GameLobbyStatus.Open,
                    closedAt: null,

                    snapshotUpdatedAt: ev.lobby.snapshotUpdatedAt,
                    lobbyTitle: ev.lobby.lobbyName,
                    hostName: ev.lobby.hostName,
                    slotsHumansTaken: ev.lobby.slotsHumansTaken,
                    slotsHumansTotal: ev.lobby.slotsHumansTotal,
                });
                this.lobbiesReopenCandidates.delete(s2lobby.id);
            }
        }
    }

    async onUpdateLobbyList(ev: JournalEventUpdateLobbyList) {
        this.updateStorageOffset(ev);
    }
}

process.on('unhandledRejection', e => { throw e; });
async function run() {
    setupFileLogger('dataproc');

    let activeRegions = [
        GameRegion.US,
        GameRegion.EU,
        GameRegion.KR,
    ];
    if (process.argv.length > 2) {
        const regionId = Number(process.argv[2]);
        if (regionId < 1 || regionId > 3) {
            logger.error(`provided invalid region`);
            return;
        }
        activeRegions = [regionId];
    }

    const workers = await Promise.all(activeRegions.map(async region => {
        const worker = new DataProc(region);
        await worker.open();
        return worker;
    }));

    if (process.env.NOTIFY_SOCKET) {
        const r = await execAsync('systemd-notify --ready');
        logger.verbose(`systemd-notify`, r);
    }

    async function terminate(sig: NodeJS.Signals) {
        logger.info(`Received ${sig}`);
        await Promise.all(workers.map(async x => {
            logger.info(`Closing worker ${GameRegion[x.region]}`);
            await x.close();
            logger.info(`Worker done ${GameRegion[x.region]}`);
        }));
    }

    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);

    await Promise.all(workers.map(x => x.work()));
    logger.info(`All workers exited`);
}

run();

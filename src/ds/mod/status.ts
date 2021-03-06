import { BotTask } from '../dscommon';
import { S2GameLobby } from '../../entity/S2GameLobby';
import { logger, logIt } from '../../logger';
import { sleep, sleepUnless } from '../../helpers';
import { GameLobbyStatus } from '../../gametracker';
import { S2GameLobbySlotKind } from '../../entity/S2GameLobbySlot';

export class StatusTask extends BotTask {
    async load() {
        setTimeout(this.update.bind(this), 500).unref();
    }

    async unload() {
    }

    protected async update() {
        this.running = true;
        while (await this.waitUntilReady()) {
            await this.showOpenLobbyCount();
            await sleepUnless(8000, () => !this.client.doShutdown);
            await this.showNumberOfRecentGames();
            await sleepUnless(8000, () => !this.client.doShutdown);
        }
        this.running = false;
    }

    @logIt()
    protected async showOpenLobbyCount() {
        await this.waitUntilReady();

        type rType = {
            lobbyCountUS: string;
            lobbyCountEU: string;
            lobbyCountKR: string;
            playerCountUS: string;
            playerCountEU: string;
            playerCountKR: string;
        };
        const result: rType = await this.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select([])
            .innerJoin('lobby.region', 'region')
            .addSelect('SUM(CASE WHEN region.code = \'US\' THEN 1 ELSE 0 END)', 'lobbyCountUS')
            .addSelect('SUM(CASE WHEN region.code = \'EU\' THEN 1 ELSE 0 END)', 'lobbyCountEU')
            .addSelect('SUM(CASE WHEN region.code = \'KR\' THEN 1 ELSE 0 END)', 'lobbyCountKR')
            .addSelect('SUM(CASE WHEN region.code = \'US\' THEN lobby.slotsHumansTaken ELSE 0 END)', 'playerCountUS')
            .addSelect('SUM(CASE WHEN region.code = \'EU\' THEN lobby.slotsHumansTaken ELSE 0 END)', 'playerCountEU')
            .addSelect('SUM(CASE WHEN region.code = \'KR\' THEN lobby.slotsHumansTaken ELSE 0 END)', 'playerCountKR')
            .where('status = :status', { status: GameLobbyStatus.Open })
            .getRawOne()
        ;

        await this.client.user.setActivity([
            `Open lobbies:\n  US:${result.lobbyCountUS} EU:${result.lobbyCountEU} KR:${result.lobbyCountKR}`,
            `Awaiting players:\n  US:${result.playerCountUS} EU:${result.playerCountEU} KR:${result.playerCountKR}`,
            `Send .help command to learn about the bot.`,
        ].join('\n'), { type: 'WATCHING' });
    }

    protected async showNumberOfRecentGames() {
        await this.waitUntilReady();

        type rType = {
            totalGames: string;
            totalPlayers: string;
        };
        const result: rType = await this.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select([])
            .leftJoin('lobby.slots', 'slot')
            .addSelect('COUNT(DISTINCT(lobby.id))', 'totalGames')
            .addSelect('COUNT(DISTINCT(slot.profile_id))', 'totalPlayers')
            .andWhere('status = :status', { status: GameLobbyStatus.Started })
            .andWhere('closed_at >= FROM_UNIXTIME(UNIX_TIMESTAMP()-3600*1)')
            .andWhere('slot.kind = :kind', { kind: S2GameLobbySlotKind.Human })
            .cache(60000)
            .getRawOne()
        ;

        await this.client.user.setActivity([
            `${result.totalGames} public games with ${result.totalPlayers}+ unique players, in last hour across all regions.`
        ].join(' | '), { type: 'WATCHING' });
    }
}

import { BattleDepot, convertImage, NestedHashDir } from '../depot';

async function populateBnetDepot() {
    const bnDepot = new BattleDepot('data/depot');
    const pubBnetDir = new NestedHashDir('data/bnet');
    const filename = '18d81abcc4847b567bc73891213fa29d6f4c9478a142baaa805837350ec3ff2a';
    const s2mvPath = await bnDepot.getPathOrRetrieve('us', `${filename}.s2mv`);
    const jpgPath = pubBnetDir.pathTo(`${filename}.jpg`);
    await convertImage(s2mvPath, jpgPath, ['-format', 'jpg', '-quality', '85', '-strip']);
}

process.on('unhandledRejection', e => { throw e; });
(async function () {
    await populateBnetDepot();
})();

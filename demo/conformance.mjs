import { runDomainConformance } from 'duelloop';
import { MyMarketDomain } from './market-domain.mjs';
const report = await runDomainConformance(() => new MyMarketDomain(), { streamId: 'market', forbiddenFeaturePaths: ['competitorBid', 'opponent.bid'] });
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;

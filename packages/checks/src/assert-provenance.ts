import { inspectPublicProvenance } from './provenance.js';
const findings = await inspectPublicProvenance(process.cwd());
if (findings.length) throw new Error(`Public provenance violations:\n${findings.join('\n')}`);
console.log('public sources contain no prohibited provenance markers');

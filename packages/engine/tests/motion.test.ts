import { describe,it,expect } from 'vitest'; import { effectiveMotion } from '../src/motion.js';
describe('ENG-015 motion preference',()=>{it('gives explicit reduce precedence and uses OS only without a choice',()=>{expect(effectiveMotion('reduce',false)).toBe('reduce');expect(effectiveMotion('allow',true)).toBe('allow');expect(effectiveMotion(null,true)).toBe('reduce')} )})

// The core character library (16 poses, 8 gestures) as one value, for the solver and the render bundle. Pure module.
import { CORE_GESTURES } from './gestures';
import { CORE_POSES } from './poses';
import type { CharacterLibrary } from '../types';

export const coreLibraryPure = (): CharacterLibrary => ({ poses: { ...CORE_POSES }, gestures: { ...CORE_GESTURES } });

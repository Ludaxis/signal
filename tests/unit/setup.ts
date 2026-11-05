import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Screen tests render whole pages against the in-process mock API; allow for slow CI machines.
configure({ asyncUtilTimeout: 4000 });

afterEach(() => {
  cleanup();
});

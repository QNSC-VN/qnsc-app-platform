import { describe, expect, it } from 'vitest';
import { REFERENCE_DDL as PUBLISHED_DDL } from '@quynhonsemiconductor/identity/testing';
import { REFERENCE_DDL } from '../src/schema-ddl';

/**
 * The consumer owns a COPY of identity's reference tables (a product generates its own with
 * `auth generate`). This fails when the PUBLISHED identity's tables move on and the copy has not.
 */
describe('the consumer schema', () => {
  it('is the DDL the published identity ships', () => {
    expect(REFERENCE_DDL).toBe(PUBLISHED_DDL);
  });
});

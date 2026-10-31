-- AlterEnum
-- A scope may only exist when a key-authenticated endpoint actually
-- honors it: WRITE_APPLICATIONS ships together with the genapi write
-- surface (file writes, checkpoints, verifications, archive/restore).
ALTER TYPE "ApiKeyScope" ADD VALUE 'WRITE_APPLICATIONS';

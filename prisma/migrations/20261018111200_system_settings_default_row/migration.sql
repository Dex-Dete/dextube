-- Create the singleton settings row so an operator can see and change the
-- security switches with plain SQL, without waiting for the app to write it.
-- `admin_bootstrap_enabled` starts FALSE: a fresh deployment will not create an
-- administrator until someone explicitly turns it on.
INSERT INTO "system_settings" ("id", "adminBootstrapEnabled", "updatedAt", "updatedBy")
VALUES (1, false, CURRENT_TIMESTAMP, 'migration')
ON CONFLICT ("id") DO NOTHING;

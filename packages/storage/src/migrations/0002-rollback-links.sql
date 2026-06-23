ALTER TABLE deployments ADD COLUMN rollback_of_domain_id TEXT;
CREATE INDEX idx_deployments_rollback_of ON deployments(rollback_of_domain_id);

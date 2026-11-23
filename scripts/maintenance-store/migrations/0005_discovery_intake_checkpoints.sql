-- Deployment state. The portable restore path clears activation after verification.
CREATE TABLE portcove_maintenance_meta.discovery_intake_activation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active boolean NOT NULL
);
INSERT INTO portcove_maintenance_meta.discovery_intake_activation (active) VALUES (true);

CREATE TABLE portcove_maintenance.discovery_intake_batches (
  request_comment bigint PRIMARY KEY CHECK (request_comment > 0),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  revision integer NOT NULL CHECK (revision > 0),
  receipt_body text NOT NULL CHECK (octet_length(receipt_body) BETWEEN 1 AND 64000),
  previous_receipt_sha256 text CHECK (previous_receipt_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE portcove_maintenance.discovery_intake_candidates (
  request_comment bigint NOT NULL REFERENCES portcove_maintenance.discovery_intake_batches,
  candidate_index integer NOT NULL CHECK (candidate_index >= 0),
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  PRIMARY KEY (request_comment, candidate_index)
);

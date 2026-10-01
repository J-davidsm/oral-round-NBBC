CREATE TABLE IF NOT EXISTS rounds (
  network TEXT NOT NULL,
  id TEXT NOT NULL,
  division TEXT NOT NULL CHECK (division IN ('primary','junior','senior')),
  record TEXT NOT NULL,
  PRIMARY KEY (network, id)
);
CREATE INDEX IF NOT EXISTS rounds_network_division ON rounds(network, division, id);

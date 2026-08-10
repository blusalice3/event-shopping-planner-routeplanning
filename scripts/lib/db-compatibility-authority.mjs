export const FINAL_DB_CONTRACT_STATUS = "remote-verified";
export const FINAL_DB_OBSERVATION_STATUS = "observed";

export const hasFinalRemoteDbAuthority = (contract) =>
  contract?.schemaVersion === 1 &&
  contract.contractStatus === FINAL_DB_CONTRACT_STATUS &&
  contract.remote?.observationStatus === FINAL_DB_OBSERVATION_STATUS &&
  Array.isArray(contract.blockerCodes) &&
  contract.blockerCodes.length === 0;

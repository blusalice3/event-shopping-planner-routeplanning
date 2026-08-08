const TRANSIENT_STATUSES = new Set(["new", "installing", "activating"]);

const assertCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

export class ServiceWorkerActivationTracker {
  constructor(serviceWorkerUrl) {
    assertCondition(
      typeof serviceWorkerUrl === "string" && serviceWorkerUrl.length > 0,
      "Service Worker URL is required.",
    );
    this.serviceWorkerUrl = serviceWorkerUrl;
    this.versions = new Map();
    this.histories = new Map();
    this.lastMatchingUpdateAt = null;
    this.baselineVersionIds = null;
    this.activationTransitions = [];
    this.prematureActivationIds = [];
    this.clientsReleaseStarted = false;
    this.selectedVersionId = null;
  }

  observe({ versions: changedVersions = [] }, observedAt = Date.now()) {
    for (const version of changedVersions) {
      if (version.scriptURL !== this.serviceWorkerUrl) continue;
      assertCondition(
        typeof version.versionId === "string" && version.versionId.length > 0,
        "Observed Service Worker version is missing versionId.",
      );
      assertCondition(
        typeof version.status === "string" && version.status.length > 0,
        `Observed Service Worker ${version.versionId} is missing status.`,
      );
      const previous = this.versions.get(version.versionId);
      if (previous?.status !== version.status) {
        const history = this.histories.get(version.versionId) ?? [];
        history.push(version.status);
        this.histories.set(version.versionId, history);
        if (
          this.baselineVersionIds &&
          version.status === "activated" &&
          previous?.status !== "activated"
        ) {
          this.activationTransitions.push(version.versionId);
          if (!this.clientsReleaseStarted) {
            this.prematureActivationIds.push(version.versionId);
          }
        }
      }
      this.versions.set(version.versionId, { ...version });
      this.lastMatchingUpdateAt = observedAt;
    }
  }

  isBaselineReady(now = Date.now(), quietWindowMs = 300) {
    const versions = this.#matchingVersions();
    return (
      !this.baselineVersionIds &&
      versions.some(({ status }) => status === "activated") &&
      versions.every(({ status }) => !TRANSIENT_STATUSES.has(status)) &&
      this.lastMatchingUpdateAt !== null &&
      now - this.lastMatchingUpdateAt >= quietWindowMs
    );
  }

  freezeBaselineVersionIds(now = Date.now(), quietWindowMs = 300) {
    assertCondition(
      this.isBaselineReady(now, quietWindowMs),
      "Service Worker baseline is not stable enough to freeze.",
    );
    this.baselineVersionIds = new Set(
      this.#matchingVersions().map(({ versionId }) => versionId),
    );
    return [...this.baselineVersionIds].sort();
  }

  getNewInstalledVersionId() {
    this.#assertBaselineFrozen();
    this.#assertNoUnexpectedActivation();
    const newVersions = this.#newVersions();
    assertCondition(
      newVersions.length <= 1,
      `Target update produced ${newVersions.length} new Service Worker versions.`,
    );
    if (newVersions.length === 0) return null;
    const [candidate] = newVersions;
    assertCondition(
      candidate.status !== "redundant",
      `New Service Worker ${candidate.versionId} became redundant before selection.`,
    );
    assertCondition(
      candidate.status !== "activating" && candidate.status !== "activated",
      `New Service Worker ${candidate.versionId} activated before client release.`,
    );
    const history = this.histories.get(candidate.versionId) ?? [];
    return candidate.status === "installed" && history.includes("installed")
      ? candidate.versionId
      : null;
  }

  markClientsReleaseStarted(versionId) {
    assertCondition(
      this.getNewInstalledVersionId() === versionId,
      "Client release is not bound to the unique newly installed Service Worker.",
    );
    this.selectedVersionId = versionId;
    this.clientsReleaseStarted = true;
  }

  isNaturalActivationComplete(now = Date.now(), quietWindowMs = 300) {
    this.#assertBaselineFrozen();
    this.#assertNoUnexpectedActivation();
    assertCondition(
      this.clientsReleaseStarted && this.selectedVersionId,
      "Natural activation was checked before client release started.",
    );
    const newVersions = this.#newVersions();
    assertCondition(
      newVersions.length === 1 &&
        newVersions[0].versionId === this.selectedVersionId,
      "Natural activation is not bound to exactly one new Service Worker version.",
    );
    const selected = newVersions[0];
    assertCondition(
      selected.status !== "redundant",
      `Selected Service Worker ${selected.versionId} became redundant.`,
    );
    const unexpectedTransitions = this.activationTransitions.filter(
      (versionId) => versionId !== this.selectedVersionId,
    );
    assertCondition(
      unexpectedTransitions.length === 0,
      `Unexpected Service Worker activation(s): ${unexpectedTransitions.join(", ")}.`,
    );
    if (selected.status !== "activated") return false;
    assertCondition(
      this.activationTransitions.filter(
        (versionId) => versionId === this.selectedVersionId,
      ).length === 1,
      "Selected Service Worker did not have exactly one observed activation transition.",
    );
    const nonRedundant = this.#matchingVersions().filter(
      ({ status }) => status !== "redundant",
    );
    if (
      nonRedundant.length !== 1 ||
      nonRedundant[0].versionId !== this.selectedVersionId ||
      nonRedundant[0].status !== "activated" ||
      this.#matchingVersions().some(({ status }) =>
        TRANSIENT_STATUSES.has(status),
      )
    ) {
      return false;
    }
    return (
      this.lastMatchingUpdateAt !== null &&
      now - this.lastMatchingUpdateAt >= quietWindowMs
    );
  }

  describe() {
    return {
      baselineVersionIds: this.baselineVersionIds
        ? [...this.baselineVersionIds].sort()
        : null,
      selectedVersionId: this.selectedVersionId,
      activationTransitions: [...this.activationTransitions],
      prematureActivationIds: [...this.prematureActivationIds],
      versions: this.#matchingVersions().map(
        ({ versionId, status, runningStatus, controlledClients }) => ({
          versionId,
          status,
          runningStatus,
          controlledClients,
          history: [...(this.histories.get(versionId) ?? [])],
        }),
      ),
    };
  }

  #assertBaselineFrozen() {
    assertCondition(
      this.baselineVersionIds instanceof Set,
      "Service Worker baseline has not been frozen.",
    );
  }

  #assertNoUnexpectedActivation() {
    assertCondition(
      this.prematureActivationIds.length === 0,
      `Service Worker(s) activated before client release: ${this.prematureActivationIds.join(", ")}.`,
    );
    const unexpected = this.activationTransitions.filter(
      (versionId) =>
        !this.selectedVersionId || versionId !== this.selectedVersionId,
    );
    assertCondition(
      unexpected.length === 0,
      `Unexpected Service Worker activation(s): ${unexpected.join(", ")}.`,
    );
  }

  #matchingVersions() {
    return [...this.versions.values()]
      .filter(({ scriptURL }) => scriptURL === this.serviceWorkerUrl)
      .sort(({ versionId: left }, { versionId: right }) =>
        left.localeCompare(right),
      );
  }

  #newVersions() {
    return this.#matchingVersions().filter(
      ({ versionId }) => !this.baselineVersionIds.has(versionId),
    );
  }
}

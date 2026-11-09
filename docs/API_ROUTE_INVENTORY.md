# HTTP API route inventory

Generated from `src/server/api/router.ts` and the direct Astro routes under `src/pages/api`. Regenerate with `pnpm api:inventory`. The inventory records the first matching branch, not a second copy of the route table.

- Dispatcher routes: **182**
- Direct Astro routes: **21**
- Shadowed or duplicate branches: **0**
- Consumer paths without a route: **0**
- OpenAPI operations without a route: **0**

`/api/v1/studio/*` is dispatched as `/api/v1/admin/*` after a live Studio role check; studio-alias branches are listed under the administrator path they execute.

## Dispatcher routes

| # | Method | Path | Guards | Agent scopes | Request schema | Side effects | Line |
|---:|---|---|---|---|---|---|---:|
| 1 | GET | `/api/v1/collections` | — | — | — | reads: filter, listCollections, listPublicCollections | 559 |
| 2 | GET | `/api/v1/collections/:param` | — | — | — | reads: getCollection, listCollectionCards, collectionProgress | 565 |
| 3 | GET | `/api/v1/catalogue` | — | — | — | reads: listCards, get, map, activeRelease | 577 |
| 4 | GET | `/api/v1/cards/:param` | — | — | — | reads: getCard, listCards, publicCard | 588 |
| 5 | GET | `/api/v1/sets` | — | — | — | reads: filter, listSets, map | 599 |
| 6 | GET | `/api/v1/pools` | requireScope | inventory:read | — | reads: installationScopeFor, get, listEligiblePools, poolScopeFromDiscord, map | 605 |
| 7 | GET | `/api/v1/pools/:param` | — | — | — | reads: installationScopeFor, get, getPoolPreview, poolScopeFromDiscord, publicPoolPreview | 638 |
| 8 | GET | `/api/v1/me/preferences` | requireScope | profile:read | — | reads: getPreferences | 657 |
| 9 | PATCH | `/api/v1/me/preferences` | requireScope | profile:write | `{ hideTags?:array, hiddenCollectionIds?:array, reducedMotion?:boolean, soundEnabled?:boolean, sharingEnabled?:boolean, profileLook?:enum, profileBio?:string, profilePresentation?:string, profilePresentationVersion?:number }` | writes: updatePreferences; reads: optional, max, nullable, positive, int | 662 |
| 10 | GET | `/api/v1/me/avatar` | requireScope | profile:read | — | reads: loadAccountAvatar, accountBannerView | 693 |
| 11 | POST | `/api/v1/me/avatar/default` | requireScope | profile:write | `{ key:string }` | writes: setDefaultAvatar; reads: max, min | 722 |
| 12 | POST | `/api/v1/me/avatar/discord` | requireScope | profile:write | — | writes: setDiscordAvatar | 728 |
| 13 | POST | `/api/v1/me/avatar/upload` | requireScope | profile:write | `{ renditions?:object }` | writes: setUploadedAvatar; reads: max, min, int, optional | 733 |
| 14 | DELETE | `/api/v1/me/avatar` | requireScope | profile:write | — | reads: removeAccountAvatar | 753 |
| 15 | POST | `/api/v1/me/banner/upload` | requireScope | profile:write | `{ renditions?:object }` | writes: setUploadedBanner; reads: max, min, int, optional | 758 |
| 16 | DELETE | `/api/v1/me/banner` | requireScope | profile:write | — | reads: removeAccountBanner | 778 |
| 17 | GET | `/api/v1/wallet` | requireScope | economy:read | — | reads: getWalletSummary | 784 |
| 18 | GET | `/api/v1/ledger` | requireScope | economy:read | — | reads: getLedger, get | 789 |
| 19 | GET | `/api/v1/inventory` | requireScope | inventory:read | — | reads: min, max, get, getInventory, countInventory | 794 |
| 20 | GET | `/api/v1/instances/:param` | requireScope | inventory:read | — | reads: getInstance | 822 |
| 21 | POST | `/api/v1/instances/:param/favourite` | requireScope | inventory:write | `{ favourite:boolean }` | writes: toggleFavourite | 827 |
| 22 | POST | `/api/v1/instances/:param/lock` | requireScope | inventory:write | `{ locked:boolean }` | writes: setLocked | 839 |
| 23 | GET | `/api/v1/members` | requireScope | inventory:read | — | reads: listTenantMembers | 845 |
| 24 | GET | `/api/v1/members/:param/trade-items` | requireScope | inventory:read | — | reads: getMemberTradeInventory | 850 |
| 25 | GET | `/api/v1/wishlist` | requireScope | inventory:read | — | reads: getWishlist | 861 |
| 26 | POST | `/api/v1/wishlist` | requireScope | inventory:write | `{ cardId:idSchema, wanted:boolean, targetVariantId?:idSchema, targetMaterialKey?:string, targetEffectKey?:string }` | writes: toggleWishlist; reads: optional, nullable, max | 866 |
| 27 | POST | `/api/v1/rewards/claim` | requireScope | reward:claim | `{  }` | writes: claimDailyReward | 887 |
| 28 | POST | `/api/v1/draws` | requireScope | draw:execute | `{ pool:string, expectedRevision:number, expectedDistribution:string, channelKey?:string, installationId?:string, channelId?:string }` | writes: executeDraw; reads: max, min, positive, int, optional | 894 |
| 29 | POST | `/api/v1/recycle/preview` | requireScope | inventory:read | `{ instanceId:idSchema }` | reads: recyclePreview | 931 |
| 30 | POST | `/api/v1/recycle` | requireScope | recycle:write | `{ instanceId:idSchema, expectedCredit:number }` | writes: recycleCommit; reads: nonnegative, int | 937 |
| 31 | POST | `/api/v1/sets/:param/claim` | requireScope | reward:claim | `{  }` | writes: claimSetCompletion | 953 |
| 32 | GET | `/api/v1/trades` | requireScope | trade:write | — | reads: listTrades | 960 |
| 33 | POST | `/api/v1/trades` | requireScope | trade:write | `{ recipientId?:idSchema, recipientEmail?:string, proposerInstanceIds:array, recipientInstanceIds:array, expiresInHours?:number, note?:string }` | writes: createTrade; reads: optional, max, email, min, int | 965 |
| 34 | GET | `/api/v1/trades/:param` | requireScope | trade:write | — | reads: getTrade | 981 |
| 35 | POST | `/api/v1/trades/:param/accept` | requireScope | trade:write | — | writes: acceptTrade, declineTrade, cancelTrade | 986 |
| 36 | POST | `/api/v1/trades/:param/decline` | requireScope | trade:write | — | writes: acceptTrade, declineTrade, cancelTrade | 986 |
| 37 | POST | `/api/v1/trades/:param/cancel` | requireScope | trade:write | — | writes: acceptTrade, declineTrade, cancelTrade | 986 |
| 38 | POST | `/api/v1/trades/expire` | ensureOps | — | — | writes: expireTrades | 1000 |
| 39 | GET | `/api/v1/gifts` | requireScope | trade:write | — | reads: listGifts | 1004 |
| 40 | POST | `/api/v1/gifts` | requireScope | trade:write | `{ recipientEmail:string, instanceId:idSchema, note?:string }` | writes: createGift; reads: max, email, optional | 1009 |
| 41 | GET | `/api/v1/me/memberships` | requireScope | profile:read | — | reads: getMyMemberships | 1023 |
| 42 | POST | `/api/v1/me/join` | — | — | — | writes: joinMainAlbum | 1028 |
| 43 | POST | `/api/v1/admin/members/:param/status` | ensureMemberAdmin, ensureStepUp | — | `{ status:enum, reason:string }` | writes: setMemberStatus; reads: max, min | 1034 |
| 44 | GET | `/api/v1/achievements` | requireScope | profile:read | — | reads: listAchievements | 1053 |
| 45 | POST | `/api/v1/achievements/evaluate` | requireScope | reward:claim | — | reads: evaluateAchievements | 1058 |
| 46 | GET | `/api/v1/gifts/received` | requireScope | trade:write | — | reads: listMyGiftReceipts | 1063 |
| 47 | GET | `/api/v1/shares` | requireScope | profile:read | — | reads: listShareLinks | 1068 |
| 48 | POST | `/api/v1/shares` | requireScope | profile:write | `{ expiresInDays?:number, kind?:z, targetId?:idSchema }` | writes: createShareLink; reads: optional, max, min, int | 1073 |
| 49 | POST | `/api/v1/shares/:param/revoke` | requireScope | profile:write | — | writes: revokeShareLink | 1088 |
| 50 | POST | `/api/v1/missions/inspect/:param` | — | — | — | writes: recordOwnedInspection | 1095 |
| 51 | GET | `/api/v1/missions/daily` | requireScope | missions:read | — | reads: getDailyMissions | 1099 |
| 52 | POST | `/api/v1/missions/daily/claim` | requireScope | missions:claim | `{ key:string }` | writes: claimDailyMission; reads: max, min, get | 1104 |
| 53 | GET | `/api/v1/npcs/lounge` | requireNpcRead | — | — | reads: listNpcProfiles | 1113 |
| 54 | GET | `/api/v1/npcs/presets` | requireNpcManager | — | — | reads: listNpcPresets | 1117 |
| 55 | GET | `/api/v1/npcs/admin` | — | — | — | reads: getNpcAdminOverview | 1121 |
| 56 | GET | `/api/v1/npcs` | requireNpcManager | — | — | reads: listNpcs | 1124 |
| 57 | POST | `/api/v1/npcs` | requireNpcManager | — | `{ name:string, presetKey:string, bio?:string, avatarUrl?:string, goalCollectionId?:idSchema, poolSlug?:string, startingBalance?:number, scheduleEnabled?:boolean, intervalMinutes?:number }` | writes: createNpc; reads: max, min, optional, nullable, int | 1129 |
| 58 | POST | `/api/v1/npcs/batch` | requireNpcManager | — | `{ presetKeys:array, prefix?:string, goalCollectionId?:idSchema }` | writes: createNpcBatch; reads: max, min, optional, nullable | 1147 |
| 59 | PATCH | `/api/v1/npcs/limits` | requireNpcManager | — | `{ maxNpcs?:number, maxDrawsPerDay?:number, pausedAll?:boolean }` | writes: setNpcLimits; reads: optional, max, min, int | 1159 |
| 60 | POST | `/api/v1/npcs/run-scheduled` | requireNpcManager | — | — | reads: runDueNpcs | 1171 |
| 61 | GET | `/api/v1/npcs/:param` | requireNpcRead, requireNpcManager, requireScope | — | — | reads: getNpc | 1177 |
| 62 | PATCH | `/api/v1/npcs/:param` | requireNpcRead, requireNpcManager, requireScope | — | `{ name?:string, bio?:string, avatarUrl?:string, presetKey?:string, goalCollectionId?:idSchema, poolSlug?:string, scheduleEnabled?:boolean, intervalMinutes?:number }` | writes: updateNpc; reads: optional, max, min, nullable, int | 1181 |
| 63 | GET | `/api/v1/npcs/:param/actions` | requireNpcRead, requireNpcManager, requireScope | — | — | reads: listNpcActions | 1198 |
| 64 | GET | `/api/v1/npcs/:param/compare` | requireNpcRead, requireNpcManager, requireScope | — | — | reads: compareNpc | 1201 |
| 65 | GET | `/api/v1/npcs/:param/trade-offers` | requireNpcRead, requireNpcManager, requireScope | — | — | reads: npcTradeOffers | 1204 |
| 66 | POST | `/api/v1/npcs/:param/trade-preview` | requireNpcRead, requireNpcManager, requireScope | trade:write | `{ giveInstanceIds:array, takeInstanceIds:array }` | reads: max, min, previewNpcTrade | 1208 |
| 67 | POST | `/api/v1/npcs/:param/trades` | requireNpcRead, requireNpcManager, requireScope | trade:write | `{ giveInstanceIds:array, takeInstanceIds:array, idempotencyKey?:string }` | writes: createNpcTrade; reads: max, min, optional, get | 1220 |
| 68 | POST | `/api/v1/npcs/:param/preview` | requireNpcRead, requireNpcManager, requireScope | — | — | reads: previewNpcAction | 1240 |
| 69 | POST | `/api/v1/npcs/:param/play` | requireNpcRead, requireNpcManager, requireScope | — | `{ idempotencyKey?:string } (optional)` | reads: optional, max, min, playNpcOnce | 1243 |
| 70 | POST | `/api/v1/npcs/:param/run` | requireNpcRead, requireNpcManager, requireScope | — | `{ count:number }` | reads: default, max, min, int, runNpcBatch | 1247 |
| 71 | POST | `/api/v1/npcs/:param/pause` | requireNpcRead, requireNpcManager, requireScope | — | — | writes: setNpcStatus | 1251 |
| 72 | POST | `/api/v1/npcs/:param/resume` | requireNpcRead, requireNpcManager, requireScope | — | — | writes: setNpcStatus | 1251 |
| 73 | POST | `/api/v1/npcs/:param/retire` | requireNpcRead, requireNpcManager, requireScope | — | — | writes: setNpcStatus | 1251 |
| 74 | GET | `/api/v1/npc-trades` | requireScope | trade:write | — | reads: listNpcTrades | 1258 |
| 75 | GET | `/api/v1/npc-trades/:param` | requireScope | trade:write | — | reads: getNpcTrade | 1263 |
| 76 | POST | `/api/v1/npc-trades/:param/confirm` | requireScope | trade:write | — | reads: confirmNpcTrade | 1268 |
| 77 | POST | `/api/v1/npc-trades/:param/cancel` | requireScope | trade:write | — | writes: cancelNpcTrade | 1273 |
| 78 | GET | `/api/v1/admin/cards` | ensureStudioCatalogueRead, ensureContentRead | — | — | writes: join; reads: isGlobalCollectionAdmin, listCards, get, map, filter | 1280 |
| 79 | POST | `/api/v1/admin/cards` | ensureContentWrite | — | `cardBody` | writes: createCard | 1333 |
| 80 | POST | `/api/v1/admin/cards/bulk` | ensureContentWrite, ensureStepUp | — | `{ ids:array, status:enum }` | writes: bulkSetStatus; reads: max | 1344 |
| 81 | PATCH | `/api/v1/admin/cards/:param` | ensureContentWrite | — | `cardPatch` | writes: updateCard | 1363 |
| 82 | DELETE | `/api/v1/admin/cards/:param` | ensureContentWrite | — | — | writes: archiveCard | 1368 |
| 83 | POST | `/api/v1/admin/cards/:param/editions` | ensureContentWrite, ensureStepUp | — | `{ name:string, subjectAssetId:idSchema, backgroundAssetId?:idSchema, recipeId?:idSchema, materials:array, effects?:array, variants?:object, status?:enum, parentEditionId?:idSchema, composition?:enum }` | writes: createEditionForCard; reads: max, min, optional, nullable | 1374 |
| 84 | GET | `/api/v1/admin/cards/:param/prints` | ensureContentRead, ensureContentWrite, ensureStepUp | — | — | reads: listPrintProposals, printCoverageForCard | 1427 |
| 85 | POST | `/api/v1/admin/cards/:param/prints` | ensureContentRead, ensureContentWrite, ensureStepUp | — | `{ printNumber:string, role:enum, title:string, creativeDirection:string, sourceAssetId:idSchema, artworkAssetId?:idSchema, backgroundAssetId?:idSchema, rightsNote?:string, sourceRefs?:array, provenance?:record, finishKeys?:array, status?:enum }` | writes: createPrintProposal; reads: max, min, optional, nullable, url | 1435 |
| 86 | POST | `/api/v1/admin/cards/:param/merge` | ensureContentWrite, ensureStepUp | — | `{ targetId:idSchema }` | writes: mergeCards | 1470 |
| 87 | GET | `/api/v1/admin/prints/:param` | ensureContentRead, ensureContentWrite, ensureStepUp | — | — | reads: getPrintProposal, listPrintProposalReviews | 1489 |
| 88 | PATCH | `/api/v1/admin/prints/:param` | ensureContentRead, ensureContentWrite, ensureStepUp | — | `{ role?:z, title?:string, creativeDirection?:string, sourceAssetId?:idSchema, artworkAssetId?:idSchema, backgroundAssetId?:idSchema, rightsNote?:string, sourceRefs?:array, finishKeys?:array, expectedRevision?:number, note?:string }` | reads: optional, max, min, nullable, url | 1497 |
| 89 | POST | `/api/v1/admin/prints/:param/submit` | ensureContentWrite, ensureStepUp | — | `{ expectedRevision?:number, note?:string }` | writes: submitPrintProposal; reads: optional, positive, int, max | 1533 |
| 90 | POST | `/api/v1/admin/prints/:param/review` | ensureContentWrite, ensureStepUp | — | `{ decision:enum, note?:string, expectedRevision?:number }` | writes: reviewPrintProposal; reads: optional, max, positive, int | 1554 |
| 91 | POST | `/api/v1/admin/prints/:param/link` | ensureContentWrite, ensureStepUp | — | `{ editionId:idSchema, expectedRevision?:number }` | writes: linkApprovedEdition; reads: optional, positive, int | 1576 |
| 92 | GET | `/api/v1/admin/recipes` | ensureContentRead | — | — | — | 1599 |
| 93 | POST | `/api/v1/admin/cards/:param/status` | ensureContentWrite, ensureStepUp | — | `{ status:enum }` | writes: setCardStatus | 1609 |
| 94 | GET | `/api/v1/admin/tenant` | ensureContentRead | — | — | reads: getTenantPublication | 1625 |
| 95 | PATCH | `/api/v1/admin/tenant` | ensureContentWrite | — | `{ publicCatalogue?:boolean, blockedTags?:array }` | writes: updateTenantPublication; reads: optional, max | 1629 |
| 96 | GET | `/api/v1/admin/taxonomy` | ensureContentRead | — | — | reads: getTaxonomy | 1640 |
| 97 | POST | `/api/v1/admin/taxonomy` | ensureContentWrite | — | `{ kind:enum, key:string, name:string, description?:string, parentId?:string, config?:unknown }` | writes: createTaxonomyItem; reads: max, min, optional, unknown | 1644 |
| 98 | DELETE | `/api/v1/admin/taxonomy/:param/:param` | ensureContentWrite | — | — | writes: archiveTaxonomyItem | 1659 |
| 99 | GET | `/api/v1/admin/sets` | ensureContentRead | — | — | reads: listSets | 1671 |
| 100 | POST | `/api/v1/admin/sets` | ensureContentWrite | — | `{ slug:string, name:string, description:string, rewardAmount:number }` | writes: createSet; reads: max, min, nonnegative, int | 1680 |
| 101 | PUT | `/api/v1/admin/sets/:param/members` | ensureContentWrite | — | `{ cardIds:array }` | writes: replaceSetMembership; reads: max | 1698 |
| 102 | POST | `/api/v1/admin/sets/:param/publish` | ensureContentWrite | — | — | writes: publishSet | 1710 |
| 103 | POST | `/api/v1/admin/catalogue/publish` | ensureContentWrite, ensureStepUp, requireScope | catalogue:publish | — | writes: publishCatalogue | 1721 |
| 104 | GET | `/api/v1/admin/catalogue/status` | ensureContentRead | — | — | reads: activeRelease | 1733 |
| 105 | GET | `/api/v1/admin/pools` | ensureContentRead | — | — | reads: listPools | 1745 |
| 106 | POST | `/api/v1/admin/pools` | ensureContentWrite | — | `{ slug:string, name:string, description:string, price:number, channelKey?:string, entries:object }` | writes: createPool; reads: max, min, nonnegative, int, optional | 1754 |
| 107 | GET | `/api/v1/admin/pools/:param` | ensureContentRead | — | — | reads: getPoolDetail | 1777 |
| 108 | PATCH | `/api/v1/admin/pools/:param` | ensureContentWrite | — | `{ expectedRevision:number, name?:string, description?:string, price?:number, entries?:object }` | writes: updatePool; reads: positive, int, optional, max, min | 1787 |
| 109 | POST | `/api/v1/admin/pools/:param/publish` | ensureContentWrite | — | — | writes: publishPool | 1811 |
| 110 | POST | `/api/v1/admin/pools/:param/retire` | ensureContentWrite | — | — | writes: retirePool | 1822 |
| 111 | GET | `/api/v1/admin/wallet-recipients` | ensureEconomyWrite | — | — | reads: listGrantRecipients | 1836 |
| 112 | GET | `/api/v1/admin/economy` | ensureEconomyRead | — | — | reads: getEconomy | 1840 |
| 113 | PATCH | `/api/v1/admin/economy` | ensureEconomyWrite, requireRecentStrongAuth | — | `{ expectedVersion:number, currencyName?:string, currencySymbol?:string, starterGrant?:number, dailyReward?:number, dailyCooldownSeconds?:number, recycleEnabled?:boolean, recycleRates?:record }` | writes: updateEconomy; reads: positive, int, optional, max, min | 1844 |
| 114 | POST | `/api/v1/admin/wallets/:param/adjust` | ensureEconomyWrite, ensureStepUp | — | `{ amount:z, reason:string }` | writes: adjustWallet; reads: refine, int, max, min | 1867 |
| 115 | GET | `/api/v1/admin/wallets/:param` | ensureEconomyRead | — | — | reads: getWalletSummary | 1897 |
| 116 | GET | `/api/v1/admin/audit` | ensureEconomyRead | — | — | reads: listAudit, get | 1907 |
| 117 | GET | `/api/v1/admin/agents` | ensureOwner | — | — | reads: listAgentGrants | 1913 |
| 118 | POST | `/api/v1/admin/agents` | ensureOwner | — | `{ agentName:string, representedUserId:idSchema, scopes:array, expiresInDays:number }` | writes: createAgentGrant; reads: max, min, int | 1917 |
| 119 | POST | `/api/v1/admin/agents/:param/revoke` | ensureOwner | — | — | writes: revokeAgentGrant | 1930 |
| 120 | GET | `/api/v1/admin/people` | ensureOps | — | — | reads: listTenantMembers | 1945 |
| 121 | GET | `/api/v1/admin/members` | ensureMemberAdmin | — | — | reads: listMembers | 1949 |
| 122 | GET | `/api/v1/admin/team` | ensureMemberAdmin | — | — | reads: botForTenant, listBotAdmins, listBotInvitations | 1953 |
| 123 | GET | `/api/v1/admin/assets` | ensureCollectionsRead | — | — | reads: listAssets, get | 1972 |
| 124 | POST | `/api/v1/admin/assets` | ensureCollectionsWrite, ensureStepUp, requireScope | import:write | — | writes: uploadAsset; reads: formData, get, isGlobalCollectionAdmin, includes, arrayBuffer | 1983 |
| 125 | POST | `/api/v1/admin/variants/:param/back` | ensureContentWrite, requireScope | render:write | — | writes: createBackRenderAsset; reads: formData, get, arrayBuffer | 2060 |
| 126 | POST | `/api/v1/admin/assets/:param/derivatives` | ensureContentWrite, requireScope | render:write | — | writes: createDerivative; reads: formData, get, includes, arrayBuffer | 2092 |
| 127 | GET | `/api/v1/admin/assets/:param/bytes` | ensureContentRead | — | — | reads: getAsset, readAsset | 2119 |
| 128 | POST | `/api/v1/admin/imports/preview` | ensureContentRead | — | `importManifest` | reads: previewImport | 2139 |
| 129 | GET | `/api/v1/admin/imports` | ensureContentRead | — | — | reads: importRuns | 2150 |
| 130 | POST | `/api/v1/admin/imports` | ensureContentWrite, requireScope | import:write | `importManifest` | writes: commitImport | 2161 |
| 131 | POST | `/api/v1/admin/renders/queue` | ensureContentWrite, requireScope | render:write | `{ force?:boolean }` | writes: createRenderJobs; reads: catch, optional | 2172 |
| 132 | GET | `/api/v1/admin/jobs` | ensureOps | — | — | reads: listRenderJobs, get | 2186 |
| 133 | POST | `/api/v1/admin/jobs/:param/claim` | ensureOps, requireScope | render:write | — | writes: claimRenderJob | 2190 |
| 134 | POST | `/api/v1/admin/jobs/:param/complete` | ensureOps, requireScope | render:write | — | writes: completeRenderJob; reads: formData, get, isInteger, arrayBuffer | 2204 |
| 135 | POST | `/api/v1/admin/jobs/:param/fail` | ensureOps, requireScope | render:write | `{ message:string, attempt:number }` | writes: failRenderJob; reads: max, min, int | 2233 |
| 136 | POST | `/api/v1/admin/generation/plan` | ensureContentWrite | — | `{ prompt:string, model?:string, count?:number }` | reads: max, min, optional, int, planGeneration | 2252 |
| 137 | GET | `/api/v1/admin/generation/jobs` | ensureContentRead | — | — | reads: listGenerationJobs | 2271 |
| 138 | GET | `/api/v1/admin/generation/jobs/:param` | ensureContentRead | — | — | reads: getGenerationJob | 2281 |
| 139 | POST | `/api/v1/admin/generation/jobs/:param/submit` | ensureContentWrite | — | — | writes: submitGeneration | 2292 |
| 140 | POST | `/api/v1/admin/generation/jobs/:param/review` | ensureContentWrite | — | `{ decision:enum }` | writes: reviewGeneration | 2304 |
| 141 | POST | `/api/v1/admin/generation/jobs/:param/adopt` | ensureContentWrite | — | — | writes: adoptGeneration | 2317 |
| 142 | GET | `/api/v1/admin/topics` | ensureContentRead | — | — | reads: listTopicPolicies | 2331 |
| 143 | POST | `/api/v1/admin/topics` | ensureContentWrite | — | `{ channelKey:string, name:string, excludeTags:array }` | writes: createTopicPolicy; reads: max, min | 2335 |
| 144 | PATCH | `/api/v1/admin/topics/:param` | ensureContentWrite | — | `{ active:boolean }` | writes: setTopicPolicyActive | 2347 |
| 145 | GET | `/api/v1/admin/backup/manifest` | ensureOps | — | — | reads: backupManifest | 2353 |
| 146 | POST | `/api/v1/admin/outbox/process` | ensureOps | — | — | writes: processOutbox | 2363 |
| 147 | GET | `/api/v1/ops/status` | ensureOps | — | — | reads: operationsStatus | 2373 |
| 148 | GET | `/api/v1/admin/status` | ensureOps | — | — | reads: operationsStatus | 2373 |
| 149 | GET | `/api/v1/bots` | — | — | — | reads: listBotsForUser | 2384 |
| 150 | POST | `/api/v1/bots` | ensureStepUp | — | `{ name:string, slug?:string, description?:string }` | writes: createBot; reads: max, min, optional | 2388 |
| 151 | POST | `/api/v1/invitations/accept` | — | — | `{ token:string }` | writes: acceptBotInvitation; reads: max, min | 2401 |
| 152 | GET | `/api/v1/admin/bot` | ensureOps | — | — | reads: botForTenant | 2405 |
| 153 | PATCH | `/api/v1/admin/bot` | ensureContentWrite | — | `{ aiArtEnabled:boolean }` | reads: botForTenant, batch, bind, prepare, stringify | 2420 |
| 154 | POST | `/api/v1/admin/bot/invitations` | ensureStepUp | — | `{ email:string, capabilities:array, expiresInDays?:number }` | writes: createBotInvitation; reads: botForTenant, max, email, min, optional | 2461 |
| 155 | PATCH | `/api/v1/admin/bot/admins/:param` | ensureOwner, ensureStepUp | — | `{ capabilities:array, selfGrantsEnabled:boolean, grantLimit:number, reason:string }` | reads: botForTenant, max, min, int, validateCapabilities | 2483 |
| 156 | POST | `/api/v1/admin/bot/admins/:param/revoke` | ensureStepUp | — | — | writes: revokeBotAdmin; reads: botForTenant | 2582 |
| 157 | GET | `/api/v1/admin/collections` | ensureCollectionsRead | — | — | reads: listCollections | 2601 |
| 158 | POST | `/api/v1/admin/collections` | ensureCollectionsWrite, ensureStepUp | — | `{ name:string, slug?:string, description?:string, scope:enum, logoUrl?:string, bannerUrl?:string, backUrl?:string, accent?:string, status?:enum, viewAudience?:enum, sourceWork?:string, sourceContext?:string, contentAdvisory?:string, featured?:boolean }` | writes: createCollection; reads: max, min, optional, default | 2610 |
| 159 | GET | `/api/v1/admin/collections/:param` | ensureCollectionsRead | — | — | reads: getCollection, listCollectionCards | 2639 |
| 160 | PATCH | `/api/v1/admin/collections/:param` | ensureCollectionsWrite, ensureStepUp | — | `{ name?:string, description?:string, logoUrl?:string, bannerUrl?:string, backUrl?:string, accent?:string, status?:enum, sort?:number, viewAudience?:enum, sourceWork?:string, sourceContext?:string, contentAdvisory?:string, featured?:boolean, expectedVersion?:number }` | writes: updateCollection; reads: optional, max, min, nullable, int | 2652 |
| 161 | POST | `/api/v1/admin/collections/:param/cards` | ensureCollectionsWrite, ensureStepUp | — | `{ cardIds:array }` | reads: max, min, addCollectionCards | 2682 |
| 162 | DELETE | `/api/v1/admin/collections/:param/cards/:param` | ensureCollectionsWrite, ensureStepUp | — | — | reads: removeCollectionCard | 2695 |
| 163 | POST | `/api/v1/admin/collections/:param/enable` | ensureContentWrite, ensureStepUp | — | `{ enabled:boolean }` | reads: enableCollection | 2709 |
| 164 | GET | `/api/v1/admin/collections/:param/viewers` | ensureCollectionsRead | — | — | reads: listCollectionViewers | 2723 |
| 165 | POST | `/api/v1/admin/collections/:param/viewers` | ensureCollectionsWrite, ensureStepUp | — | `{ userIds:array }` | writes: setCollectionViewers; reads: max | 2734 |
| 166 | GET | `/api/v1/admin/collections/:param/progress` | ensureCollectionsRead | — | — | reads: collectionProgress | 2747 |
| 167 | GET | `/api/v1/admin/achievements` | ensureContentRead | — | — | reads: listAchievements | 2760 |
| 168 | POST | `/api/v1/admin/achievements/backfill` | ensureContentWrite, ensureStepUp | — | — | writes: backfillAchievements; reads: min, max, get | 2769 |
| 169 | POST | `/api/v1/admin/achievements` | ensureContentWrite, ensureStepUp | — | `{ scope:enum, key:string, name:string, description:string, criteria:record, reward?:record, visibility?:enum, artKey?:string, category?:string }` | writes: createAchievement; reads: default, max, min, unknown, optional | 2782 |
| 170 | GET | `/api/v1/admin/gifts` | ensureEconomyRead | — | — | reads: listAdminGiftCampaigns | 2806 |
| 171 | POST | `/api/v1/admin/gifts/preview` | ensureEconomyWrite | — | `giftSchema` | reads: previewAdminGift | 2815 |
| 172 | POST | `/api/v1/admin/gifts` | ensureEconomyWrite, ensureStepUp | — | `giftSchema` | writes: sendAdminGift | 2831 |
| 173 | POST | `/api/v1/admin/gifts/:param/retry` | ensureEconomyWrite, ensureStepUp | — | — | writes: processGiftCampaign | 2845 |
| 174 | GET | `/api/v1/platform/overview` | requireSuperAdmin | — | — | — | 2859 |
| 175 | GET | `/api/v1/platform/accounts` | requireSuperAdmin | — | — | — | 2906 |
| 176 | GET | `/api/v1/platform/people` | requireSuperAdmin | — | — | reads: listPlatformPeople, get | 2919 |
| 177 | GET | `/api/v1/platform/roles` | requireSuperAdmin | — | — | reads: listPlatformRoleAssignments | 2929 |
| 178 | POST | `/api/v1/platform/roles` | requireSuperAdmin, ensureStepUp | — | `{ userId:idSchema, role:enum, scopes?:boolean, reason:string }` | writes: assignPlatformRole; reads: optional, max, min | 2938 |
| 179 | POST | `/api/v1/platform/roles/:param/revoke` | requireSuperAdmin, ensureStepUp | — | `{ role:enum, reason:string }` | writes: revokePlatformRole; reads: max, min | 2962 |
| 180 | PATCH | `/api/v1/platform/installations/:param` | requireSuperAdmin, ensureStepUp | — | `{ channelAllowlist?:string, gameEnabled?:boolean, websiteEnabled?:boolean, apiEnabled?:boolean, publicCatalogueEnabled?:boolean, adminGuiEnabled?:boolean, active?:boolean }` | writes: replace, join; reads: optional, max, regex, push, stringify | 2981 |
| 181 | POST | `/api/v1/platform/bots/:param/status` | requireSuperAdmin, ensureStepUp | — | `{ status:enum }` | reads: run, bind, prepare, stringify | 3056 |
| 182 | GET | `/api/v1/platform/collections` | requireSuperAdmin | — | — | reads: filter, listCollections | 3098 |

## Direct Astro routes

| Method | Path |
|---|---|
| POST | `/api/discord/interactions` |
| GET | `/api/discord/interactions` |
| GET | `/api/probe` |
| GET | `/api/v1/admin/access-session` |
| POST | `/api/v1/auth/login` |
| POST | `/api/v1/auth/logout` |
| POST | `/api/v1/auth/magic-link` |
| POST | `/api/v1/auth/passkey/login/options` |
| POST | `/api/v1/auth/passkey/login/verify` |
| POST | `/api/v1/auth/passkey/register/options` |
| POST | `/api/v1/auth/passkey/register/verify` |
| POST | `/api/v1/bootstrap` |
| POST | `/api/v1/bots/:param/switch` |
| POST | `/api/v1/dev/demo-album` |
| POST | `/api/v1/dev/login` |
| GET | `/api/v1/me` |
| GET | `/api/v1/platform/access-session` |
| ALL | `/api/v1/security` |
| GET | `/api/v1/security` |
| POST | `/api/v1/security` |
| GET | `/api/v1/status` |

## Precedence check

No earlier dispatcher branch accepts a later branch's example path.

## Consumer reconciliation

All 376 browser, CLI and MCP paths resolve to a dispatcher or direct Astro route.

## OpenAPI reconciliation

All 70 documented operations resolve to a dispatcher or direct Astro route.

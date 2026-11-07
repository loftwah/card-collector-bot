# HTTP API route inventory

Generated from `src/server/api/router.ts` and the direct Astro routes under `src/pages/api`. Regenerate with `pnpm api:inventory`. The inventory records the first matching branch, not a second copy of the route table.

- Dispatcher routes: **168**
- Direct Astro routes: **21**
- Shadowed or duplicate branches: **0**
- Consumer paths without a route: **0**
- OpenAPI operations without a route: **0**

`/api/v1/studio/*` is dispatched as `/api/v1/admin/*` after a live Studio role check; studio-alias branches are listed under the administrator path they execute.

## Dispatcher routes

| # | Method | Path | Guards | Agent scopes | Request schema | Side effects | Line |
|---:|---|---|---|---|---|---|---:|
| 1 | GET | `/api/v1/collections` | — | — | — | reads: filter, listCollections, listPublicCollections | 537 |
| 2 | GET | `/api/v1/collections/:param` | — | — | — | reads: getCollection, listCollectionCards, collectionProgress | 543 |
| 3 | GET | `/api/v1/catalogue` | — | — | — | reads: listCards, get, map, activeRelease | 555 |
| 4 | GET | `/api/v1/cards/:param` | — | — | — | reads: getCard, listCards, publicCard | 566 |
| 5 | GET | `/api/v1/sets` | — | — | — | reads: filter, listSets, map | 577 |
| 6 | GET | `/api/v1/pools` | requireScope | inventory:read | — | reads: installationScopeFor, get, listEligiblePools, poolScopeFromDiscord, map | 583 |
| 7 | GET | `/api/v1/pools/:param` | — | — | — | reads: installationScopeFor, get, getPoolPreview, poolScopeFromDiscord, publicPoolPreview | 616 |
| 8 | GET | `/api/v1/me/preferences` | requireScope | profile:read | — | reads: getPreferences | 635 |
| 9 | PATCH | `/api/v1/me/preferences` | requireScope | profile:write | `{ hideTags?:array, hiddenCollectionIds?:array, reducedMotion?:boolean, soundEnabled?:boolean, sharingEnabled?:boolean, profileLook?:enum, profileBio?:string, profilePresentation?:string, profilePresentationVersion?:number }` | writes: updatePreferences; reads: optional, max, nullable, positive, int | 640 |
| 10 | GET | `/api/v1/wallet` | requireScope | economy:read | — | reads: getWalletSummary | 671 |
| 11 | GET | `/api/v1/ledger` | requireScope | economy:read | — | reads: getLedger, get | 676 |
| 12 | GET | `/api/v1/inventory` | requireScope | inventory:read | — | reads: min, max, get, getInventory, countInventory | 681 |
| 13 | GET | `/api/v1/instances/:param` | requireScope | inventory:read | — | reads: getInstance | 709 |
| 14 | POST | `/api/v1/instances/:param/favourite` | requireScope | inventory:write | `{ favourite:boolean }` | writes: toggleFavourite | 714 |
| 15 | POST | `/api/v1/instances/:param/lock` | requireScope | inventory:write | `{ locked:boolean }` | writes: setLocked | 726 |
| 16 | GET | `/api/v1/members` | requireScope | inventory:read | — | reads: listTenantMembers | 732 |
| 17 | GET | `/api/v1/members/:param/trade-items` | requireScope | inventory:read | — | reads: getMemberTradeInventory | 737 |
| 18 | GET | `/api/v1/wishlist` | requireScope | inventory:read | — | reads: getWishlist | 748 |
| 19 | POST | `/api/v1/wishlist` | requireScope | inventory:write | `{ cardId:idSchema, wanted:boolean, targetVariantId?:idSchema, targetMaterialKey?:string, targetEffectKey?:string }` | writes: toggleWishlist; reads: optional, nullable, max | 753 |
| 20 | POST | `/api/v1/rewards/claim` | requireScope | reward:claim | `{  }` | writes: claimDailyReward | 774 |
| 21 | POST | `/api/v1/draws` | requireScope | draw:execute | `{ pool:string, expectedRevision:number, expectedDistribution:string, channelKey?:string, installationId?:string, channelId?:string }` | writes: executeDraw; reads: max, min, positive, int, optional | 781 |
| 22 | POST | `/api/v1/recycle/preview` | requireScope | inventory:read | `{ instanceId:idSchema }` | reads: recyclePreview | 818 |
| 23 | POST | `/api/v1/recycle` | requireScope | recycle:write | `{ instanceId:idSchema, expectedCredit:number }` | writes: recycleCommit; reads: nonnegative, int | 824 |
| 24 | POST | `/api/v1/sets/:param/claim` | requireScope | reward:claim | `{  }` | writes: claimSetCompletion | 840 |
| 25 | GET | `/api/v1/trades` | requireScope | trade:write | — | reads: listTrades | 847 |
| 26 | POST | `/api/v1/trades` | requireScope | trade:write | `{ recipientId?:idSchema, recipientEmail?:string, proposerInstanceIds:array, recipientInstanceIds:array, expiresInHours?:number, note?:string }` | writes: createTrade; reads: optional, max, email, min, int | 852 |
| 27 | GET | `/api/v1/trades/:param` | requireScope | trade:write | — | reads: getTrade | 868 |
| 28 | POST | `/api/v1/trades/:param/accept` | requireScope | trade:write | — | writes: acceptTrade, declineTrade, cancelTrade | 873 |
| 29 | POST | `/api/v1/trades/:param/decline` | requireScope | trade:write | — | writes: acceptTrade, declineTrade, cancelTrade | 873 |
| 30 | POST | `/api/v1/trades/:param/cancel` | requireScope | trade:write | — | writes: acceptTrade, declineTrade, cancelTrade | 873 |
| 31 | POST | `/api/v1/trades/expire` | ensureOps | — | — | writes: expireTrades | 887 |
| 32 | GET | `/api/v1/gifts` | requireScope | trade:write | — | reads: listGifts | 891 |
| 33 | POST | `/api/v1/gifts` | requireScope | trade:write | `{ recipientEmail:string, instanceId:idSchema, note?:string }` | writes: createGift; reads: max, email, optional | 896 |
| 34 | GET | `/api/v1/me/memberships` | requireScope | profile:read | — | reads: getMyMemberships | 910 |
| 35 | POST | `/api/v1/me/join` | — | — | — | writes: joinMainAlbum | 915 |
| 36 | POST | `/api/v1/admin/members/:param/status` | ensureMemberAdmin, ensureStepUp | — | `{ status:enum, reason:string }` | writes: setMemberStatus; reads: max, min | 921 |
| 37 | GET | `/api/v1/achievements` | requireScope | profile:read | — | reads: listAchievements | 940 |
| 38 | POST | `/api/v1/achievements/evaluate` | requireScope | reward:claim | — | reads: evaluateAchievements | 945 |
| 39 | GET | `/api/v1/gifts/received` | requireScope | trade:write | — | reads: listMyGiftReceipts | 950 |
| 40 | GET | `/api/v1/shares` | requireScope | profile:read | — | reads: listShareLinks | 955 |
| 41 | POST | `/api/v1/shares` | requireScope | profile:write | `{ expiresInDays?:number, kind?:z, targetId?:idSchema }` | writes: createShareLink; reads: optional, max, min, int | 960 |
| 42 | POST | `/api/v1/shares/:param/revoke` | requireScope | profile:write | — | writes: revokeShareLink | 975 |
| 43 | POST | `/api/v1/missions/inspect/:param` | — | — | — | writes: recordOwnedInspection | 982 |
| 44 | GET | `/api/v1/missions/daily` | requireScope | missions:read | — | reads: getDailyMissions | 986 |
| 45 | POST | `/api/v1/missions/daily/claim` | requireScope | missions:claim | `{ key:string }` | writes: claimDailyMission; reads: max, min, get | 991 |
| 46 | GET | `/api/v1/npcs/lounge` | requireNpcRead | — | — | reads: listNpcProfiles | 1000 |
| 47 | GET | `/api/v1/npcs/presets` | requireNpcManager | — | — | reads: listNpcPresets | 1004 |
| 48 | GET | `/api/v1/npcs/admin` | — | — | — | reads: getNpcAdminOverview | 1008 |
| 49 | GET | `/api/v1/npcs` | requireNpcManager | — | — | reads: listNpcs | 1011 |
| 50 | POST | `/api/v1/npcs` | requireNpcManager | — | `{ name:string, presetKey:string, bio?:string, avatarUrl?:string, goalCollectionId?:idSchema, poolSlug?:string, startingBalance?:number, scheduleEnabled?:boolean, intervalMinutes?:number }` | writes: createNpc; reads: max, min, optional, nullable, int | 1016 |
| 51 | POST | `/api/v1/npcs/batch` | requireNpcManager | — | `{ presetKeys:array, prefix?:string, goalCollectionId?:idSchema }` | writes: createNpcBatch; reads: max, min, optional, nullable | 1034 |
| 52 | PATCH | `/api/v1/npcs/limits` | requireNpcManager | — | `{ maxNpcs?:number, maxDrawsPerDay?:number, pausedAll?:boolean }` | writes: setNpcLimits; reads: optional, max, min, int | 1046 |
| 53 | POST | `/api/v1/npcs/run-scheduled` | requireNpcManager | — | — | reads: runDueNpcs | 1058 |
| 54 | GET | `/api/v1/npcs/:param` | requireNpcRead, requireNpcManager | — | — | reads: getNpc | 1064 |
| 55 | PATCH | `/api/v1/npcs/:param` | requireNpcRead, requireNpcManager | — | `{ name?:string, bio?:string, avatarUrl?:string, presetKey?:string, goalCollectionId?:idSchema, poolSlug?:string, scheduleEnabled?:boolean, intervalMinutes?:number }` | writes: updateNpc; reads: optional, max, min, nullable, int | 1068 |
| 56 | GET | `/api/v1/npcs/:param/actions` | requireNpcRead, requireNpcManager | — | — | reads: listNpcActions | 1085 |
| 57 | GET | `/api/v1/npcs/:param/compare` | requireNpcRead, requireNpcManager | — | — | reads: compareNpc | 1088 |
| 58 | POST | `/api/v1/npcs/:param/preview` | requireNpcRead, requireNpcManager | — | — | reads: previewNpcAction | 1091 |
| 59 | POST | `/api/v1/npcs/:param/play` | requireNpcRead, requireNpcManager | — | `{ idempotencyKey?:string } (optional)` | reads: optional, max, min, playNpcOnce | 1094 |
| 60 | POST | `/api/v1/npcs/:param/run` | requireNpcRead, requireNpcManager | — | `{ count:number }` | reads: default, max, min, int, runNpcBatch | 1098 |
| 61 | POST | `/api/v1/npcs/:param/pause` | requireNpcRead, requireNpcManager | — | — | writes: setNpcStatus | 1102 |
| 62 | POST | `/api/v1/npcs/:param/resume` | requireNpcRead, requireNpcManager | — | — | writes: setNpcStatus | 1102 |
| 63 | POST | `/api/v1/npcs/:param/retire` | requireNpcRead, requireNpcManager | — | — | writes: setNpcStatus | 1102 |
| 64 | GET | `/api/v1/admin/cards` | ensureStudioCatalogueRead, ensureContentRead | — | — | writes: join; reads: isGlobalCollectionAdmin, listCards, get, map, filter | 1108 |
| 65 | POST | `/api/v1/admin/cards` | ensureContentWrite | — | `cardBody` | writes: createCard | 1161 |
| 66 | POST | `/api/v1/admin/cards/bulk` | ensureContentWrite, ensureStepUp | — | `{ ids:array, status:enum }` | writes: bulkSetStatus; reads: max | 1172 |
| 67 | PATCH | `/api/v1/admin/cards/:param` | ensureContentWrite | — | `cardPatch` | writes: updateCard | 1191 |
| 68 | DELETE | `/api/v1/admin/cards/:param` | ensureContentWrite | — | — | writes: archiveCard | 1196 |
| 69 | POST | `/api/v1/admin/cards/:param/editions` | ensureContentWrite, ensureStepUp | — | `{ name:string, subjectAssetId:idSchema, backgroundAssetId?:idSchema, recipeId?:idSchema, materials:array, effects?:array, variants?:object, status?:enum, parentEditionId?:idSchema, composition?:enum }` | writes: createEditionForCard; reads: max, min, optional, nullable | 1202 |
| 70 | GET | `/api/v1/admin/cards/:param/prints` | ensureContentRead, ensureContentWrite, ensureStepUp | — | — | reads: listPrintProposals, printCoverageForCard | 1255 |
| 71 | POST | `/api/v1/admin/cards/:param/prints` | ensureContentRead, ensureContentWrite, ensureStepUp | — | `{ printNumber:string, role:enum, title:string, creativeDirection:string, sourceAssetId:idSchema, artworkAssetId?:idSchema, backgroundAssetId?:idSchema, rightsNote?:string, sourceRefs?:array, provenance?:record, finishKeys?:array, status?:enum }` | writes: createPrintProposal; reads: max, min, optional, nullable, url | 1263 |
| 72 | POST | `/api/v1/admin/cards/:param/merge` | ensureContentWrite, ensureStepUp | — | `{ targetId:idSchema }` | writes: mergeCards | 1298 |
| 73 | GET | `/api/v1/admin/prints/:param` | ensureContentRead, ensureContentWrite, ensureStepUp | — | — | reads: getPrintProposal, listPrintProposalReviews | 1317 |
| 74 | PATCH | `/api/v1/admin/prints/:param` | ensureContentRead, ensureContentWrite, ensureStepUp | — | `{ role?:z, title?:string, creativeDirection?:string, sourceAssetId?:idSchema, artworkAssetId?:idSchema, backgroundAssetId?:idSchema, rightsNote?:string, sourceRefs?:array, finishKeys?:array, expectedRevision?:number, note?:string }` | reads: optional, max, min, nullable, url | 1325 |
| 75 | POST | `/api/v1/admin/prints/:param/submit` | ensureContentWrite, ensureStepUp | — | `{ expectedRevision?:number, note?:string }` | writes: submitPrintProposal; reads: optional, positive, int, max | 1361 |
| 76 | POST | `/api/v1/admin/prints/:param/review` | ensureContentWrite, ensureStepUp | — | `{ decision:enum, note?:string, expectedRevision?:number }` | writes: reviewPrintProposal; reads: optional, max, positive, int | 1382 |
| 77 | POST | `/api/v1/admin/prints/:param/link` | ensureContentWrite, ensureStepUp | — | `{ editionId:idSchema, expectedRevision?:number }` | writes: linkApprovedEdition; reads: optional, positive, int | 1404 |
| 78 | GET | `/api/v1/admin/recipes` | ensureContentRead | — | — | — | 1427 |
| 79 | POST | `/api/v1/admin/cards/:param/status` | ensureContentWrite, ensureStepUp | — | `{ status:enum }` | writes: setCardStatus | 1437 |
| 80 | GET | `/api/v1/admin/tenant` | ensureContentRead | — | — | reads: getTenantPublication | 1453 |
| 81 | PATCH | `/api/v1/admin/tenant` | ensureContentWrite | — | `{ publicCatalogue?:boolean, blockedTags?:array }` | writes: updateTenantPublication; reads: optional, max | 1457 |
| 82 | GET | `/api/v1/admin/taxonomy` | ensureContentRead | — | — | reads: getTaxonomy | 1468 |
| 83 | POST | `/api/v1/admin/taxonomy` | ensureContentWrite | — | `{ kind:enum, key:string, name:string, description?:string, parentId?:string, config?:unknown }` | writes: createTaxonomyItem; reads: max, min, optional, unknown | 1472 |
| 84 | DELETE | `/api/v1/admin/taxonomy/:param/:param` | ensureContentWrite | — | — | writes: archiveTaxonomyItem | 1487 |
| 85 | GET | `/api/v1/admin/sets` | ensureContentRead | — | — | reads: listSets | 1499 |
| 86 | POST | `/api/v1/admin/sets` | ensureContentWrite | — | `{ slug:string, name:string, description:string, rewardAmount:number }` | writes: createSet; reads: max, min, nonnegative, int | 1508 |
| 87 | PUT | `/api/v1/admin/sets/:param/members` | ensureContentWrite | — | `{ cardIds:array }` | writes: replaceSetMembership; reads: max | 1526 |
| 88 | POST | `/api/v1/admin/sets/:param/publish` | ensureContentWrite | — | — | writes: publishSet | 1538 |
| 89 | POST | `/api/v1/admin/catalogue/publish` | ensureContentWrite, ensureStepUp, requireScope | catalogue:publish | — | writes: publishCatalogue | 1549 |
| 90 | GET | `/api/v1/admin/catalogue/status` | ensureContentRead | — | — | reads: activeRelease | 1561 |
| 91 | GET | `/api/v1/admin/pools` | ensureContentRead | — | — | reads: listPools | 1573 |
| 92 | POST | `/api/v1/admin/pools` | ensureContentWrite | — | `{ slug:string, name:string, description:string, price:number, channelKey?:string, entries:object }` | writes: createPool; reads: max, min, nonnegative, int, optional | 1582 |
| 93 | GET | `/api/v1/admin/pools/:param` | ensureContentRead | — | — | reads: getPoolDetail | 1605 |
| 94 | PATCH | `/api/v1/admin/pools/:param` | ensureContentWrite | — | `{ expectedRevision:number, name?:string, description?:string, price?:number, entries?:object }` | writes: updatePool; reads: positive, int, optional, max, min | 1615 |
| 95 | POST | `/api/v1/admin/pools/:param/publish` | ensureContentWrite | — | — | writes: publishPool | 1639 |
| 96 | POST | `/api/v1/admin/pools/:param/retire` | ensureContentWrite | — | — | writes: retirePool | 1650 |
| 97 | GET | `/api/v1/admin/wallet-recipients` | ensureEconomyWrite | — | — | reads: listGrantRecipients | 1664 |
| 98 | GET | `/api/v1/admin/economy` | ensureEconomyRead | — | — | reads: getEconomy | 1668 |
| 99 | PATCH | `/api/v1/admin/economy` | ensureEconomyWrite, requireRecentStrongAuth | — | `{ expectedVersion:number, currencyName?:string, currencySymbol?:string, starterGrant?:number, dailyReward?:number, dailyCooldownSeconds?:number, recycleEnabled?:boolean, recycleRates?:record }` | writes: updateEconomy; reads: positive, int, optional, max, min | 1672 |
| 100 | POST | `/api/v1/admin/wallets/:param/adjust` | ensureEconomyWrite, ensureStepUp | — | `{ amount:z, reason:string }` | writes: adjustWallet; reads: refine, int, max, min | 1695 |
| 101 | GET | `/api/v1/admin/wallets/:param` | ensureEconomyRead | — | — | reads: getWalletSummary | 1725 |
| 102 | GET | `/api/v1/admin/audit` | ensureEconomyRead | — | — | reads: listAudit, get | 1735 |
| 103 | GET | `/api/v1/admin/agents` | ensureOwner | — | — | reads: listAgentGrants | 1741 |
| 104 | POST | `/api/v1/admin/agents` | ensureOwner | — | `{ agentName:string, representedUserId:idSchema, scopes:array, expiresInDays:number }` | writes: createAgentGrant; reads: max, min, int | 1745 |
| 105 | POST | `/api/v1/admin/agents/:param/revoke` | ensureOwner | — | — | writes: revokeAgentGrant | 1758 |
| 106 | GET | `/api/v1/admin/people` | ensureOps | — | — | reads: listTenantMembers | 1773 |
| 107 | GET | `/api/v1/admin/members` | ensureMemberAdmin | — | — | reads: listMembers | 1777 |
| 108 | GET | `/api/v1/admin/team` | ensureMemberAdmin | — | — | reads: botForTenant, listBotAdmins, listBotInvitations | 1781 |
| 109 | GET | `/api/v1/admin/assets` | ensureCollectionsRead | — | — | reads: listAssets, get | 1800 |
| 110 | POST | `/api/v1/admin/assets` | ensureCollectionsWrite, ensureStepUp, requireScope | import:write | — | writes: uploadAsset; reads: formData, get, isGlobalCollectionAdmin, includes, arrayBuffer | 1811 |
| 111 | POST | `/api/v1/admin/variants/:param/back` | ensureContentWrite, requireScope | render:write | — | writes: createBackRenderAsset; reads: formData, get, arrayBuffer | 1875 |
| 112 | POST | `/api/v1/admin/assets/:param/derivatives` | ensureContentWrite, requireScope | render:write | — | writes: createDerivative; reads: formData, get, includes, arrayBuffer | 1907 |
| 113 | GET | `/api/v1/admin/assets/:param/bytes` | ensureContentRead | — | — | reads: getAsset, readAsset | 1934 |
| 114 | POST | `/api/v1/admin/imports/preview` | ensureContentRead | — | `importManifest` | reads: previewImport | 1954 |
| 115 | GET | `/api/v1/admin/imports` | ensureContentRead | — | — | reads: importRuns | 1965 |
| 116 | POST | `/api/v1/admin/imports` | ensureContentWrite, requireScope | import:write | `importManifest` | writes: commitImport | 1976 |
| 117 | POST | `/api/v1/admin/renders/queue` | ensureContentWrite, requireScope | render:write | `{ force?:boolean }` | writes: createRenderJobs; reads: catch, optional | 1987 |
| 118 | GET | `/api/v1/admin/jobs` | ensureOps | — | — | reads: listRenderJobs, get | 2001 |
| 119 | POST | `/api/v1/admin/jobs/:param/claim` | ensureOps, requireScope | render:write | — | writes: claimRenderJob | 2005 |
| 120 | POST | `/api/v1/admin/jobs/:param/complete` | ensureOps, requireScope | render:write | — | writes: completeRenderJob; reads: formData, get, isInteger, arrayBuffer | 2019 |
| 121 | POST | `/api/v1/admin/jobs/:param/fail` | ensureOps, requireScope | render:write | `{ message:string, attempt:number }` | writes: failRenderJob; reads: max, min, int | 2048 |
| 122 | POST | `/api/v1/admin/generation/plan` | ensureContentWrite | — | `{ prompt:string, model?:string, count?:number }` | reads: max, min, optional, int, planGeneration | 2067 |
| 123 | GET | `/api/v1/admin/generation/jobs` | ensureContentRead | — | — | reads: listGenerationJobs | 2086 |
| 124 | GET | `/api/v1/admin/generation/jobs/:param` | ensureContentRead | — | — | reads: getGenerationJob | 2096 |
| 125 | POST | `/api/v1/admin/generation/jobs/:param/submit` | ensureContentWrite | — | — | writes: submitGeneration | 2107 |
| 126 | POST | `/api/v1/admin/generation/jobs/:param/review` | ensureContentWrite | — | `{ decision:enum }` | writes: reviewGeneration | 2119 |
| 127 | POST | `/api/v1/admin/generation/jobs/:param/adopt` | ensureContentWrite | — | — | writes: adoptGeneration | 2132 |
| 128 | GET | `/api/v1/admin/topics` | ensureContentRead | — | — | reads: listTopicPolicies | 2146 |
| 129 | POST | `/api/v1/admin/topics` | ensureContentWrite | — | `{ channelKey:string, name:string, excludeTags:array }` | writes: createTopicPolicy; reads: max, min | 2150 |
| 130 | PATCH | `/api/v1/admin/topics/:param` | ensureContentWrite | — | `{ active:boolean }` | writes: setTopicPolicyActive | 2162 |
| 131 | GET | `/api/v1/admin/backup/manifest` | ensureOps | — | — | reads: backupManifest | 2168 |
| 132 | POST | `/api/v1/admin/outbox/process` | ensureOps | — | — | writes: processOutbox | 2178 |
| 133 | GET | `/api/v1/ops/status` | ensureOps | — | — | reads: operationsStatus | 2188 |
| 134 | GET | `/api/v1/admin/status` | ensureOps | — | — | reads: operationsStatus | 2188 |
| 135 | GET | `/api/v1/bots` | — | — | — | reads: listBotsForUser | 2199 |
| 136 | POST | `/api/v1/bots` | ensureStepUp | — | `{ name:string, slug?:string, description?:string }` | writes: createBot; reads: max, min, optional | 2203 |
| 137 | POST | `/api/v1/invitations/accept` | — | — | `{ token:string }` | writes: acceptBotInvitation; reads: max, min | 2216 |
| 138 | GET | `/api/v1/admin/bot` | ensureOps | — | — | reads: botForTenant | 2220 |
| 139 | PATCH | `/api/v1/admin/bot` | ensureContentWrite | — | `{ aiArtEnabled:boolean }` | reads: botForTenant, batch, bind, prepare, stringify | 2235 |
| 140 | POST | `/api/v1/admin/bot/invitations` | ensureStepUp | — | `{ email:string, capabilities:array, expiresInDays?:number }` | writes: createBotInvitation; reads: botForTenant, max, email, min, optional | 2276 |
| 141 | PATCH | `/api/v1/admin/bot/admins/:param` | ensureOwner, ensureStepUp | — | `{ capabilities:array, selfGrantsEnabled:boolean, grantLimit:number, reason:string }` | reads: botForTenant, max, min, int, validateCapabilities | 2298 |
| 142 | POST | `/api/v1/admin/bot/admins/:param/revoke` | ensureStepUp | — | — | writes: revokeBotAdmin; reads: botForTenant | 2397 |
| 143 | GET | `/api/v1/admin/collections` | ensureCollectionsRead | — | — | reads: listCollections | 2416 |
| 144 | POST | `/api/v1/admin/collections` | ensureCollectionsWrite, ensureStepUp | — | `{ name:string, slug?:string, description?:string, scope:enum, logoUrl?:string, bannerUrl?:string, backUrl?:string, accent?:string, status?:enum, viewAudience?:enum, sourceWork?:string, sourceContext?:string, contentAdvisory?:string, featured?:boolean }` | writes: createCollection; reads: max, min, optional, default | 2425 |
| 145 | GET | `/api/v1/admin/collections/:param` | ensureCollectionsRead | — | — | reads: getCollection, listCollectionCards | 2454 |
| 146 | PATCH | `/api/v1/admin/collections/:param` | ensureCollectionsWrite, ensureStepUp | — | `{ name?:string, description?:string, logoUrl?:string, bannerUrl?:string, backUrl?:string, accent?:string, status?:enum, sort?:number, viewAudience?:enum, sourceWork?:string, sourceContext?:string, contentAdvisory?:string, featured?:boolean, expectedVersion?:number }` | writes: updateCollection; reads: optional, max, min, nullable, int | 2467 |
| 147 | POST | `/api/v1/admin/collections/:param/cards` | ensureCollectionsWrite, ensureStepUp | — | `{ cardIds:array }` | reads: max, min, addCollectionCards | 2497 |
| 148 | DELETE | `/api/v1/admin/collections/:param/cards/:param` | ensureCollectionsWrite, ensureStepUp | — | — | reads: removeCollectionCard | 2510 |
| 149 | POST | `/api/v1/admin/collections/:param/enable` | ensureContentWrite, ensureStepUp | — | `{ enabled:boolean }` | reads: enableCollection | 2524 |
| 150 | GET | `/api/v1/admin/collections/:param/viewers` | ensureCollectionsRead | — | — | reads: listCollectionViewers | 2538 |
| 151 | POST | `/api/v1/admin/collections/:param/viewers` | ensureCollectionsWrite, ensureStepUp | — | `{ userIds:array }` | writes: setCollectionViewers; reads: max | 2549 |
| 152 | GET | `/api/v1/admin/collections/:param/progress` | ensureCollectionsRead | — | — | reads: collectionProgress | 2562 |
| 153 | GET | `/api/v1/admin/achievements` | ensureContentRead | — | — | reads: listAchievements | 2575 |
| 154 | POST | `/api/v1/admin/achievements/backfill` | ensureContentWrite, ensureStepUp | — | — | writes: backfillAchievements; reads: min, max, get | 2584 |
| 155 | POST | `/api/v1/admin/achievements` | ensureContentWrite, ensureStepUp | — | `{ scope:enum, key:string, name:string, description:string, criteria:record, reward?:record, visibility?:enum, artKey?:string, category?:string }` | writes: createAchievement; reads: default, max, min, unknown, optional | 2597 |
| 156 | GET | `/api/v1/admin/gifts` | ensureEconomyRead | — | — | reads: listAdminGiftCampaigns | 2621 |
| 157 | POST | `/api/v1/admin/gifts/preview` | ensureEconomyWrite | — | `giftSchema` | reads: previewAdminGift | 2630 |
| 158 | POST | `/api/v1/admin/gifts` | ensureEconomyWrite, ensureStepUp | — | `giftSchema` | writes: sendAdminGift | 2646 |
| 159 | POST | `/api/v1/admin/gifts/:param/retry` | ensureEconomyWrite, ensureStepUp | — | — | writes: processGiftCampaign | 2660 |
| 160 | GET | `/api/v1/platform/overview` | requireSuperAdmin | — | — | — | 2674 |
| 161 | GET | `/api/v1/platform/accounts` | requireSuperAdmin | — | — | — | 2721 |
| 162 | GET | `/api/v1/platform/people` | requireSuperAdmin | — | — | reads: listPlatformPeople, get | 2734 |
| 163 | GET | `/api/v1/platform/roles` | requireSuperAdmin | — | — | reads: listPlatformRoleAssignments | 2744 |
| 164 | POST | `/api/v1/platform/roles` | requireSuperAdmin, ensureStepUp | — | `{ userId:idSchema, role:enum, scopes?:boolean, reason:string }` | writes: assignPlatformRole; reads: optional, max, min | 2753 |
| 165 | POST | `/api/v1/platform/roles/:param/revoke` | requireSuperAdmin, ensureStepUp | — | `{ role:enum, reason:string }` | writes: revokePlatformRole; reads: max, min | 2777 |
| 166 | PATCH | `/api/v1/platform/installations/:param` | requireSuperAdmin, ensureStepUp | — | `{ channelAllowlist?:string, gameEnabled?:boolean, websiteEnabled?:boolean, apiEnabled?:boolean, publicCatalogueEnabled?:boolean, adminGuiEnabled?:boolean, active?:boolean }` | writes: replace, join; reads: optional, max, regex, push, stringify | 2796 |
| 167 | POST | `/api/v1/platform/bots/:param/status` | requireSuperAdmin, ensureStepUp | — | `{ status:enum }` | reads: run, bind, prepare, stringify | 2871 |
| 168 | GET | `/api/v1/platform/collections` | requireSuperAdmin | — | — | reads: filter, listCollections | 2913 |

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

All 342 browser, CLI and MCP paths resolve to a dispatcher or direct Astro route.

## OpenAPI reconciliation

All 70 documented operations resolve to a dispatcher or direct Astro route.

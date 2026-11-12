# HTTP API route inventory

Generated from `src/server/api/router.ts` and the direct Astro routes under `src/pages/api`. Regenerate with `pnpm api:inventory`. The inventory records the first matching branch, not a second copy of the route table.

- Dispatcher routes: **205**
- Direct Astro routes: **21**
- Shadowed or duplicate branches: **0**
- Consumer paths without a route: **0**
- OpenAPI operations without a route: **0**

`/api/v1/studio/*` is dispatched as `/api/v1/admin/*` after a live Studio role check; studio-alias branches are listed under the administrator path they execute.

The `/api/v1/admin/art/*` branches delegate to `src/server/api/art-lab-routes.ts`. That module enforces the live Art Lab role, category and collection scope, CSRF, job claim state and audit events on every request; the table below records the delegation rather than expanding the module's checks.

## Dispatcher routes

| # | Method | Path | Guards | Agent scopes | Request schema | Side effects | Line |
|---:|---|---|---|---|---|---|---:|
| 1 | GET | `/api/v1/admin/art` | — | — | — | reads: routeArtLab | 565 |
| 2 | GET | `/api/v1/admin/art/options` | — | — | — | reads: routeArtLab | 568 |
| 3 | GET | `/api/v1/admin/art/taste` | — | — | — | reads: routeArtLab | 571 |
| 4 | POST | `/api/v1/admin/art/taste` | — | — | — | reads: routeArtLab | 574 |
| 5 | GET | `/api/v1/admin/art/count` | — | — | — | reads: routeArtLab | 577 |
| 6 | GET | `/api/v1/admin/art/agent` | — | — | — | reads: routeArtLab | 580 |
| 7 | GET | `/api/v1/admin/art/brand` | — | — | — | reads: routeArtLab | 583 |
| 8 | POST | `/api/v1/admin/art/brand/selection` | — | — | — | reads: routeArtLab | 586 |
| 9 | POST | `/api/v1/admin/art/briefs` | — | — | — | reads: routeArtLab | 594 |
| 10 | GET | `/api/v1/admin/art/briefs/:param` | — | — | — | reads: routeArtLab | 597 |
| 11 | POST | `/api/v1/admin/art/briefs/:param/generate` | — | — | — | reads: routeArtLab | 600 |
| 12 | POST | `/api/v1/admin/art/jobs/claim` | — | — | — | reads: routeArtLab | 609 |
| 13 | POST | `/api/v1/admin/art/jobs/:param/candidates` | — | — | — | reads: routeArtLab | 617 |
| 14 | POST | `/api/v1/admin/art/jobs/:param/complete` | — | — | — | reads: routeArtLab | 626 |
| 15 | POST | `/api/v1/admin/art/jobs/:param/fail` | — | — | — | reads: routeArtLab | 635 |
| 16 | POST | `/api/v1/admin/art/jobs/:param/cancel` | — | — | — | reads: routeArtLab | 644 |
| 17 | POST | `/api/v1/admin/art/candidates/:param/feedback` | — | — | — | reads: routeArtLab | 653 |
| 18 | POST | `/api/v1/admin/art/candidates/:param/approve` | — | — | — | reads: routeArtLab | 662 |
| 19 | POST | `/api/v1/admin/art/candidates/:param/reject` | — | — | — | reads: routeArtLab | 671 |
| 20 | POST | `/api/v1/admin/art/candidates/:param/publish` | — | — | — | reads: routeArtLab | 680 |
| 21 | POST | `/api/v1/admin/art/candidates/:param/render` | — | — | — | reads: routeArtLab | 689 |
| 22 | GET | `/api/v1/admin/art/candidates/:param/file` | — | — | — | reads: routeArtLab | 698 |
| 23 | POST | `/api/v1/admin/art/approvals/:param/rollback` | — | — | — | reads: routeArtLab | 707 |
| 24 | GET | `/api/v1/collections` | — | — | — | reads: filter, listCollections, listPublicCollections | 720 |
| 25 | GET | `/api/v1/collections/:param` | — | — | — | reads: getCollection, listCollectionCards, collectionProgress | 726 |
| 26 | GET | `/api/v1/catalogue` | — | — | — | reads: get, isSafeInteger, listCards, map, activeRelease | 738 |
| 27 | GET | `/api/v1/cards/:param` | — | — | — | reads: publicCard, getCatalogueCard | 752 |
| 28 | GET | `/api/v1/sets` | — | — | — | reads: filter, listSets, map | 755 |
| 29 | GET | `/api/v1/pools` | requireScope | inventory:read | — | reads: installationScopeFor, get, listEligiblePools, poolScopeFromDiscord, map | 761 |
| 30 | GET | `/api/v1/pools/:param` | — | — | — | reads: installationScopeFor, get, getPoolPreview, poolScopeFromDiscord, publicPoolPreview | 794 |
| 31 | GET | `/api/v1/me/preferences` | requireScope | profile:read | — | reads: getPreferences | 813 |
| 32 | PATCH | `/api/v1/me/preferences` | requireScope | profile:write | `{ hideTags?:array, hiddenCollectionIds?:array, reducedMotion?:boolean, soundEnabled?:boolean, sharingEnabled?:boolean, profileLook?:enum, profileBio?:string, profilePresentation?:string, profilePresentationVersion?:number }` | writes: updatePreferences; reads: optional, max, nullable, positive, int | 823 |
| 33 | GET | `/api/v1/me/avatar` | requireScope | profile:read | — | reads: loadAccountAvatar, accountBannerView | 859 |
| 34 | POST | `/api/v1/me/avatar/default` | requireScope | profile:write | `{ key:string }` | writes: setDefaultAvatar; reads: max, min | 893 |
| 35 | POST | `/api/v1/me/avatar/discord` | requireScope | profile:write | — | writes: setDiscordAvatar | 905 |
| 36 | POST | `/api/v1/me/avatar/upload` | requireScope | profile:write | `{ renditions?:object }` | writes: setUploadedAvatar; reads: max, min, int, optional | 916 |
| 37 | DELETE | `/api/v1/me/avatar` | requireScope | profile:write | — | reads: removeAccountAvatar | 942 |
| 38 | POST | `/api/v1/me/banner/upload` | requireScope | profile:write | `{ renditions?:object }` | writes: setUploadedBanner; reads: max, min, int, optional | 952 |
| 39 | DELETE | `/api/v1/me/banner` | requireScope | profile:write | — | reads: removeAccountBanner | 978 |
| 40 | GET | `/api/v1/wallet` | requireScope | economy:read | — | reads: getWalletSummary | 989 |
| 41 | GET | `/api/v1/ledger` | requireScope | economy:read | — | reads: getLedger, get | 994 |
| 42 | GET | `/api/v1/inventory` | requireScope | inventory:read | — | reads: min, max, get, getInventory, countInventory | 999 |
| 43 | GET | `/api/v1/instances/:param` | requireScope | inventory:read | — | reads: getInstance | 1027 |
| 44 | POST | `/api/v1/instances/:param/favourite` | requireScope | inventory:write | `{ favourite:boolean }` | writes: toggleFavourite | 1032 |
| 45 | POST | `/api/v1/instances/:param/lock` | requireScope | inventory:write | `{ locked:boolean }` | writes: setLocked | 1044 |
| 46 | GET | `/api/v1/members` | requireScope | inventory:read | — | reads: listTenantMembers | 1056 |
| 47 | GET | `/api/v1/members/:param/trade-items` | requireScope | inventory:read | — | reads: getMemberTradeInventory | 1061 |
| 48 | GET | `/api/v1/wishlist` | requireScope | inventory:read | — | reads: getWishlist | 1072 |
| 49 | POST | `/api/v1/wishlist` | requireScope | inventory:write | `{ cardId:idSchema, wanted:boolean, targetVariantId?:idSchema, targetMaterialKey?:string, targetEffectKey?:string }` | writes: toggleWishlist; reads: optional, nullable, max | 1077 |
| 50 | POST | `/api/v1/rewards/claim` | requireScope | reward:claim | `{  }` | writes: claimDailyReward | 1098 |
| 51 | POST | `/api/v1/draws` | requireScope | draw:execute | `{ pool:string, expectedRevision:number, expectedDistribution:string, channelKey?:string, installationId?:string, channelId?:string }` | writes: executeDraw; reads: max, min, positive, int, optional | 1110 |
| 52 | POST | `/api/v1/recycle/preview` | requireScope | inventory:read | `{ instanceId:idSchema }` | reads: recyclePreview | 1147 |
| 53 | POST | `/api/v1/recycle` | requireScope | recycle:write | `{ instanceId:idSchema, expectedCredit:number }` | writes: recycleCommit; reads: nonnegative, int | 1158 |
| 54 | POST | `/api/v1/sets/:param/claim` | requireScope | reward:claim | `{  }` | writes: claimSetCompletion | 1174 |
| 55 | GET | `/api/v1/trades` | requireScope | trade:write | — | reads: listTrades | 1187 |
| 56 | POST | `/api/v1/trades` | requireScope | trade:write | `{ recipientId?:idSchema, recipientEmail?:string, proposerInstanceIds:array, recipientInstanceIds:array, expiresInHours?:number, note?:string }` | writes: createTrade; reads: optional, max, email, min, int | 1192 |
| 57 | GET | `/api/v1/trades/:param` | requireScope | trade:write | — | reads: getTrade | 1208 |
| 58 | POST | `/api/v1/trades/:param/accept` | requireScope | trade:write | — | writes: acceptTrade, declineTrade, cancelTrade | 1213 |
| 59 | POST | `/api/v1/trades/:param/decline` | requireScope | trade:write | — | writes: acceptTrade, declineTrade, cancelTrade | 1213 |
| 60 | POST | `/api/v1/trades/:param/cancel` | requireScope | trade:write | — | writes: acceptTrade, declineTrade, cancelTrade | 1213 |
| 61 | POST | `/api/v1/trades/expire` | ensureOps | — | — | writes: expireTrades | 1227 |
| 62 | GET | `/api/v1/gifts` | requireScope | trade:write | — | reads: listGifts | 1236 |
| 63 | POST | `/api/v1/gifts` | requireScope | trade:write | `{ recipientEmail:string, instanceId:idSchema, note?:string }` | writes: createGift; reads: max, email, optional | 1241 |
| 64 | GET | `/api/v1/me/memberships` | requireScope | profile:read | — | reads: getMyMemberships | 1255 |
| 65 | POST | `/api/v1/me/join` | — | — | — | writes: joinMainAlbum | 1265 |
| 66 | POST | `/api/v1/admin/members/:param/status` | ensureMemberAdmin, ensureStepUp | — | `{ status:enum, reason:string }` | writes: setMemberStatus; reads: max, min | 1280 |
| 67 | GET | `/api/v1/achievements` | requireScope | profile:read | — | reads: listAchievements | 1299 |
| 68 | POST | `/api/v1/achievements/evaluate` | requireScope | reward:claim | — | reads: evaluateAchievements | 1304 |
| 69 | GET | `/api/v1/gifts/received` | requireScope | trade:write | — | reads: listMyGiftReceipts | 1314 |
| 70 | GET | `/api/v1/shares` | requireScope | profile:read | — | reads: listShareLinks | 1324 |
| 71 | POST | `/api/v1/shares` | requireScope | profile:write | `{ expiresInDays?:number, kind?:z, targetId?:idSchema }` | writes: createShareLink; reads: optional, max, min, int | 1329 |
| 72 | POST | `/api/v1/shares/:param/revoke` | requireScope | profile:write | — | writes: revokeShareLink | 1344 |
| 73 | POST | `/api/v1/missions/inspect/:param` | — | — | — | writes: recordOwnedInspection | 1357 |
| 74 | GET | `/api/v1/missions/daily` | requireScope | missions:read | — | reads: getDailyMissions | 1367 |
| 75 | POST | `/api/v1/missions/daily/claim` | requireScope | missions:claim | `{ key:string }` | writes: claimDailyMission; reads: max, min, get | 1377 |
| 76 | GET | `/api/v1/npcs/lounge` | requireNpcRead | — | — | reads: listNpcProfiles | 1394 |
| 77 | GET | `/api/v1/npcs/presets` | requireNpcManager | — | — | reads: listNpcPresets | 1403 |
| 78 | GET | `/api/v1/npcs/admin` | — | — | — | reads: getNpcAdminOverview | 1412 |
| 79 | GET | `/api/v1/npcs` | requireNpcManager | — | — | reads: listNpcs | 1420 |
| 80 | POST | `/api/v1/npcs` | requireNpcManager | — | `{ name:string, presetKey:string, bio?:string, avatarUrl?:string, goalCollectionId?:idSchema, poolSlug?:string, startingBalance?:number, scheduleEnabled?:boolean, intervalMinutes?:number }` | writes: createNpc; reads: max, min, optional, nullable, int | 1425 |
| 81 | POST | `/api/v1/npcs/batch` | requireNpcManager | — | `{ presetKeys:array, prefix?:string, goalCollectionId?:idSchema }` | writes: createNpcBatch; reads: max, min, optional, nullable | 1443 |
| 82 | PATCH | `/api/v1/npcs/limits` | requireNpcManager | — | `{ maxNpcs?:number, maxDrawsPerDay?:number, pausedAll?:boolean }` | writes: setNpcLimits; reads: optional, max, min, int | 1460 |
| 83 | POST | `/api/v1/npcs/run-scheduled` | requireNpcManager | — | — | reads: runDueNpcs | 1477 |
| 84 | GET | `/api/v1/npcs/:param` | requireNpcRead, requireNpcManager, requireScope | — | — | reads: getNpc | 1488 |
| 85 | PATCH | `/api/v1/npcs/:param` | requireNpcRead, requireNpcManager, requireScope | — | `{ name?:string, bio?:string, avatarUrl?:string, presetKey?:string, goalCollectionId?:idSchema, poolSlug?:string, scheduleEnabled?:boolean, intervalMinutes?:number }` | writes: updateNpc; reads: optional, max, min, nullable, int | 1492 |
| 86 | GET | `/api/v1/npcs/:param/actions` | requireNpcRead, requireNpcManager, requireScope | — | — | reads: listNpcActions | 1509 |
| 87 | GET | `/api/v1/npcs/:param/compare` | requireNpcRead, requireNpcManager, requireScope | — | — | reads: compareNpc | 1512 |
| 88 | GET | `/api/v1/npcs/:param/trade-offers` | requireNpcRead, requireNpcManager, requireScope | — | — | reads: npcTradeOffers | 1515 |
| 89 | POST | `/api/v1/npcs/:param/trade-preview` | requireNpcRead, requireNpcManager, requireScope | trade:write | `{ giveInstanceIds:array, takeInstanceIds:array }` | reads: max, min, previewNpcTrade | 1519 |
| 90 | POST | `/api/v1/npcs/:param/trades` | requireNpcRead, requireNpcManager, requireScope | trade:write | `{ giveInstanceIds:array, takeInstanceIds:array, idempotencyKey?:string }` | writes: createNpcTrade; reads: max, min, optional, get | 1531 |
| 91 | POST | `/api/v1/npcs/:param/preview` | requireNpcRead, requireNpcManager, requireScope | — | — | reads: previewNpcAction | 1552 |
| 92 | POST | `/api/v1/npcs/:param/play` | requireNpcRead, requireNpcManager, requireScope | — | `{ idempotencyKey?:string } (optional)` | reads: optional, max, min, playNpcOnce | 1555 |
| 93 | POST | `/api/v1/npcs/:param/run` | requireNpcRead, requireNpcManager, requireScope | — | `{ count:number }` | reads: default, max, min, int, runNpcBatch | 1562 |
| 94 | POST | `/api/v1/npcs/:param/pause` | requireNpcRead, requireNpcManager, requireScope | — | — | writes: setNpcStatus | 1569 |
| 95 | POST | `/api/v1/npcs/:param/resume` | requireNpcRead, requireNpcManager, requireScope | — | — | writes: setNpcStatus | 1569 |
| 96 | POST | `/api/v1/npcs/:param/retire` | requireNpcRead, requireNpcManager, requireScope | — | — | writes: setNpcStatus | 1569 |
| 97 | GET | `/api/v1/npc-trades` | requireScope | trade:write | — | reads: listNpcTrades | 1586 |
| 98 | GET | `/api/v1/npc-trades/:param` | requireScope | trade:write | — | reads: getNpcTrade | 1591 |
| 99 | POST | `/api/v1/npc-trades/:param/confirm` | requireScope | trade:write | — | reads: confirmNpcTrade | 1596 |
| 100 | POST | `/api/v1/npc-trades/:param/cancel` | requireScope | trade:write | — | writes: cancelNpcTrade | 1607 |
| 101 | GET | `/api/v1/admin/cards` | ensureStudioCatalogueRead, ensureContentRead | — | — | writes: join; reads: isGlobalCollectionAdmin, listCards, get, map, filter | 1620 |
| 102 | POST | `/api/v1/admin/cards` | ensureContentWrite | — | `cardBody` | writes: createCard | 1673 |
| 103 | POST | `/api/v1/admin/cards/bulk` | ensureContentWrite, ensureStepUp | — | `{ ids:array, status:enum }` | writes: bulkSetStatus; reads: max | 1684 |
| 104 | PATCH | `/api/v1/admin/cards/:param` | ensureContentWrite | — | `cardPatch` | writes: updateCard | 1703 |
| 105 | DELETE | `/api/v1/admin/cards/:param` | ensureContentWrite | — | — | writes: archiveCard | 1708 |
| 106 | POST | `/api/v1/admin/cards/:param/editions` | ensureContentWrite, ensureStepUp | — | `{ name:string, subjectAssetId:idSchema, backgroundAssetId?:idSchema, recipeId?:idSchema, materials:array, effects?:array, variants?:object, status?:enum, parentEditionId?:idSchema, composition?:enum }` | writes: createEditionForCard; reads: max, min, optional, nullable | 1714 |
| 107 | GET | `/api/v1/admin/cards/:param/prints` | ensureContentRead, ensureContentWrite, ensureStepUp | — | — | reads: listPrintProposals, printCoverageForCard | 1767 |
| 108 | POST | `/api/v1/admin/cards/:param/prints` | ensureContentRead, ensureContentWrite, ensureStepUp | — | `{ printNumber:string, role:enum, title:string, creativeDirection:string, sourceAssetId:idSchema, artworkAssetId?:idSchema, backgroundAssetId?:idSchema, rightsNote?:string, sourceRefs?:array, provenance?:record, finishKeys?:enum, status?:enum }` | writes: createPrintProposal; reads: max, min, optional, nullable, url | 1775 |
| 109 | POST | `/api/v1/admin/cards/:param/merge` | ensureContentWrite, ensureStepUp | — | `{ targetId:idSchema }` | writes: mergeCards | 1813 |
| 110 | GET | `/api/v1/admin/prints/:param` | ensureContentRead, ensureContentWrite, ensureStepUp | — | — | reads: getPrintProposal, listPrintProposalReviews | 1827 |
| 111 | PATCH | `/api/v1/admin/prints/:param` | ensureContentRead, ensureContentWrite, ensureStepUp | — | `{ role?:z, title?:string, creativeDirection?:string, sourceAssetId?:idSchema, artworkAssetId?:idSchema, backgroundAssetId?:idSchema, rightsNote?:string, sourceRefs?:array, finishKeys?:enum, expectedRevision?:number, note?:string }` | reads: optional, max, min, nullable, url | 1835 |
| 112 | POST | `/api/v1/admin/prints/:param/submit` | ensureContentWrite, ensureStepUp | — | `{ expectedRevision?:number, note?:string }` | writes: submitPrintProposal; reads: optional, positive, int, max | 1874 |
| 113 | POST | `/api/v1/admin/prints/:param/review` | ensureContentWrite, ensureStepUp | — | `{ decision:enum, note?:string, expectedRevision?:number }` | writes: reviewPrintProposal; reads: optional, max, positive, int | 1895 |
| 114 | POST | `/api/v1/admin/prints/:param/link` | ensureContentWrite, ensureStepUp | — | `{ editionId:idSchema, expectedRevision?:number }` | writes: linkApprovedEdition; reads: optional, positive, int | 1917 |
| 115 | GET | `/api/v1/admin/recipes` | ensureContentRead | — | — | — | 1940 |
| 116 | POST | `/api/v1/admin/cards/:param/status` | ensureContentWrite, ensureStepUp | — | `{ status:enum }` | writes: setCardStatus | 1955 |
| 117 | GET | `/api/v1/admin/tenant` | ensureContentRead | — | — | reads: getTenantPublication | 1971 |
| 118 | PATCH | `/api/v1/admin/tenant` | ensureContentWrite | — | `{ publicCatalogue?:boolean, blockedTags?:array }` | writes: updateTenantPublication; reads: optional, max | 1980 |
| 119 | GET | `/api/v1/admin/taxonomy` | ensureContentRead | — | — | reads: getTaxonomy | 1996 |
| 120 | POST | `/api/v1/admin/taxonomy` | ensureContentWrite | — | `{ kind:enum, key:string, name:string, description?:string, parentId?:string, config?:unknown }` | writes: createTaxonomyItem; reads: max, min, optional, unknown | 2005 |
| 121 | DELETE | `/api/v1/admin/taxonomy/:param/:param` | ensureContentWrite | — | — | writes: archiveTaxonomyItem | 2025 |
| 122 | GET | `/api/v1/admin/sets` | ensureContentRead | — | — | reads: listSets | 2037 |
| 123 | POST | `/api/v1/admin/sets` | ensureContentWrite | — | `{ slug:string, name:string, description:string, rewardAmount:number }` | writes: createSet; reads: max, min, nonnegative, int | 2046 |
| 124 | PUT | `/api/v1/admin/sets/:param/members` | ensureContentWrite | — | `{ cardIds:array }` | writes: replaceSetMembership; reads: max | 2064 |
| 125 | POST | `/api/v1/admin/sets/:param/publish` | ensureContentWrite | — | — | writes: publishSet | 2076 |
| 126 | POST | `/api/v1/admin/catalogue/publish` | ensureContentWrite, ensureStepUp, requireScope | catalogue:publish | — | writes: publishCatalogue | 2087 |
| 127 | GET | `/api/v1/admin/catalogue/status` | ensureContentRead | — | — | reads: activeRelease | 2099 |
| 128 | GET | `/api/v1/admin/pools` | ensureContentRead | — | — | reads: listPools | 2111 |
| 129 | POST | `/api/v1/admin/pools` | ensureContentWrite | — | `{ slug:string, name:string, description:string, price:number, channelKey?:string, entries:object }` | writes: createPool; reads: max, min, nonnegative, int, optional | 2120 |
| 130 | GET | `/api/v1/admin/pools/:param` | ensureContentRead | — | — | reads: getPoolDetail | 2143 |
| 131 | PATCH | `/api/v1/admin/pools/:param` | ensureContentWrite | — | `{ expectedRevision:number, name?:string, description?:string, price?:number, entries?:object }` | writes: updatePool; reads: positive, int, optional, max, min | 2153 |
| 132 | POST | `/api/v1/admin/pools/:param/publish` | ensureContentWrite | — | — | writes: publishPool | 2177 |
| 133 | POST | `/api/v1/admin/pools/:param/retire` | ensureContentWrite | — | — | writes: retirePool | 2188 |
| 134 | GET | `/api/v1/admin/wallet-recipients` | ensureEconomyWrite | — | — | reads: listGrantRecipients | 2202 |
| 135 | GET | `/api/v1/admin/economy` | ensureEconomyRead | — | — | reads: getEconomy | 2211 |
| 136 | PATCH | `/api/v1/admin/economy` | ensureEconomyWrite, requireRecentStrongAuth | — | `{ expectedVersion:number, currencyName?:string, currencySymbol?:string, starterGrant?:number, dailyReward?:number, dailyCooldownSeconds?:number, recycleEnabled?:boolean, recycleRates?:record }` | writes: updateEconomy; reads: positive, int, optional, max, min | 2220 |
| 137 | POST | `/api/v1/admin/wallets/:param/adjust` | ensureEconomyWrite, ensureStepUp | — | `{ amount:z, reason:string }` | writes: adjustWallet; reads: refine, int, max, min | 2248 |
| 138 | GET | `/api/v1/admin/wallets/:param` | ensureEconomyRead | — | — | reads: getWalletSummary | 2278 |
| 139 | GET | `/api/v1/admin/audit` | ensureEconomyRead | — | — | reads: listAudit, get | 2288 |
| 140 | GET | `/api/v1/admin/agents` | ensureOwner | — | — | reads: listAgentGrants | 2299 |
| 141 | POST | `/api/v1/admin/agents` | ensureOwner | — | `{ agentName:string, representedUserId:idSchema, scopes:array, expiresInDays:number }` | writes: createAgentGrant; reads: max, min, int | 2308 |
| 142 | POST | `/api/v1/admin/agents/:param/revoke` | ensureOwner | — | — | writes: revokeAgentGrant | 2326 |
| 143 | GET | `/api/v1/admin/people` | ensureOps | — | — | reads: listTenantMembers | 2341 |
| 144 | GET | `/api/v1/admin/members` | ensureMemberAdmin | — | — | reads: listMembers | 2350 |
| 145 | GET | `/api/v1/admin/team` | ensureMemberAdmin | — | — | reads: botForTenant, listBotAdmins, listBotInvitations | 2359 |
| 146 | GET | `/api/v1/admin/assets` | ensureCollectionsRead | — | — | reads: listAssets, get | 2383 |
| 147 | POST | `/api/v1/admin/assets` | ensureCollectionsWrite, ensureStepUp, requireScope | import:write | — | writes: uploadAsset; reads: formData, get, isGlobalCollectionAdmin, includes, safeParse | 2394 |
| 148 | POST | `/api/v1/admin/variants/:param/back` | ensureContentWrite, requireScope | render:write | — | writes: createBackRenderAsset; reads: formData, get, arrayBuffer | 2491 |
| 149 | POST | `/api/v1/admin/assets/:param/derivatives` | ensureContentWrite, requireScope | render:write | — | writes: createDerivative; reads: formData, get, includes, arrayBuffer | 2523 |
| 150 | GET | `/api/v1/admin/assets/:param/bytes` | ensureContentRead | — | — | reads: getAsset, readAsset | 2550 |
| 151 | POST | `/api/v1/admin/imports/preview` | ensureContentRead | — | `importManifest` | reads: previewImport | 2570 |
| 152 | GET | `/api/v1/admin/imports` | ensureContentRead | — | — | reads: importRuns | 2581 |
| 153 | POST | `/api/v1/admin/imports` | ensureContentWrite, requireScope | import:write | `importManifest` | writes: commitImport | 2592 |
| 154 | POST | `/api/v1/admin/renders/queue` | ensureContentWrite, requireScope | render:write | `{ force?:boolean, collection?:string }` | writes: createRenderJobs; reads: catch, optional, max, min, trim | 2603 |
| 155 | GET | `/api/v1/admin/jobs` | ensureOps | — | — | reads: listRenderJobs, get | 2626 |
| 156 | POST | `/api/v1/admin/jobs/:param/claim` | ensureOps, requireScope | render:write | — | writes: claimRenderJob | 2635 |
| 157 | POST | `/api/v1/admin/jobs/:param/complete` | ensureOps, requireScope | render:write | — | writes: completeRenderJob; reads: formData, get, isInteger, arrayBuffer | 2649 |
| 158 | POST | `/api/v1/admin/jobs/:param/fail` | ensureOps, requireScope | render:write | `{ message:string, attempt:number }` | writes: failRenderJob; reads: max, min, int | 2678 |
| 159 | POST | `/api/v1/admin/generation/plan` | ensureContentWrite | — | `{ prompt:string, model?:string, count?:number }` | reads: max, min, optional, int, planGeneration | 2697 |
| 160 | GET | `/api/v1/admin/generation/jobs` | ensureContentRead | — | — | reads: listGenerationJobs | 2716 |
| 161 | GET | `/api/v1/admin/generation/jobs/:param` | ensureContentRead | — | — | reads: getGenerationJob | 2726 |
| 162 | POST | `/api/v1/admin/generation/jobs/:param/submit` | ensureContentWrite | — | — | writes: submitGeneration | 2737 |
| 163 | POST | `/api/v1/admin/generation/jobs/:param/review` | ensureContentWrite | — | `{ decision:enum }` | writes: reviewGeneration | 2749 |
| 164 | POST | `/api/v1/admin/generation/jobs/:param/adopt` | ensureContentWrite | — | — | writes: adoptGeneration | 2762 |
| 165 | GET | `/api/v1/admin/topics` | ensureContentRead | — | — | reads: listTopicPolicies | 2776 |
| 166 | POST | `/api/v1/admin/topics` | ensureContentWrite | — | `{ channelKey:string, name:string, excludeTags:array }` | writes: createTopicPolicy; reads: max, min | 2785 |
| 167 | PATCH | `/api/v1/admin/topics/:param` | ensureContentWrite | — | `{ active:boolean }` | writes: setTopicPolicyActive | 2802 |
| 168 | GET | `/api/v1/admin/backup/manifest` | ensureOps | — | — | reads: backupManifest | 2814 |
| 169 | POST | `/api/v1/admin/outbox/process` | ensureOps | — | — | writes: processOutbox | 2824 |
| 170 | GET | `/api/v1/ops/status` | ensureOps | — | — | reads: operationsStatus | 2834 |
| 171 | GET | `/api/v1/admin/status` | ensureOps | — | — | reads: operationsStatus | 2834 |
| 172 | GET | `/api/v1/bots` | — | — | — | reads: listBotsForUser | 2845 |
| 173 | POST | `/api/v1/bots` | ensureStepUp | — | `{ name:string, slug?:string, description?:string }` | writes: createBot; reads: max, min, optional | 2849 |
| 174 | POST | `/api/v1/invitations/accept` | — | — | `{ token:string }` | writes: acceptBotInvitation; reads: max, min | 2862 |
| 175 | GET | `/api/v1/admin/bot` | ensureOps | — | — | reads: botForTenant | 2871 |
| 176 | PATCH | `/api/v1/admin/bot` | ensureContentWrite | — | `{ aiArtEnabled:boolean }` | reads: botForTenant, batch, bind, prepare, stringify | 2886 |
| 177 | POST | `/api/v1/admin/bot/invitations` | ensureStepUp | — | `{ email:string, capabilities:array, expiresInDays?:number }` | writes: createBotInvitation; reads: botForTenant, max, email, min, optional | 2932 |
| 178 | PATCH | `/api/v1/admin/bot/admins/:param` | ensureOwner, ensureStepUp | — | `{ capabilities:array, selfGrantsEnabled:boolean, grantLimit:number, reason:string }` | reads: botForTenant, max, min, int, validateCapabilities | 2954 |
| 179 | POST | `/api/v1/admin/bot/admins/:param/revoke` | ensureStepUp | — | — | writes: revokeBotAdmin; reads: botForTenant | 3061 |
| 180 | GET | `/api/v1/admin/collections` | ensureCollectionsRead | — | — | reads: listCollections | 3080 |
| 181 | POST | `/api/v1/admin/collections` | ensureCollectionsWrite, ensureStepUp | — | `{ name:string, slug?:string, description?:string, scope:enum, logoUrl?:string, bannerUrl?:string, backUrl?:string, accent?:string, status?:enum, viewAudience?:enum, sourceWork?:string, sourceContext?:string, contentAdvisory?:string, featured?:boolean }` | writes: createCollection; reads: max, min, optional, default | 3089 |
| 182 | GET | `/api/v1/admin/collections/:param` | ensureCollectionsRead | — | — | reads: getCollection, listCollectionCards | 3118 |
| 183 | PATCH | `/api/v1/admin/collections/:param` | ensureCollectionsWrite, ensureStepUp | — | `{ name?:string, description?:string, logoUrl?:string, bannerUrl?:string, backUrl?:string, accent?:string, status?:enum, sort?:number, viewAudience?:enum, sourceWork?:string, sourceContext?:string, contentAdvisory?:string, featured?:boolean, expectedVersion?:number }` | writes: updateCollection; reads: optional, max, min, nullable, int | 3131 |
| 184 | POST | `/api/v1/admin/collections/:param/cards` | ensureCollectionsWrite, ensureStepUp | — | `{ cardIds:array }` | reads: max, min, addCollectionCards | 3161 |
| 185 | DELETE | `/api/v1/admin/collections/:param/cards/:param` | ensureCollectionsWrite, ensureStepUp | — | — | reads: removeCollectionCard | 3174 |
| 186 | POST | `/api/v1/admin/collections/:param/enable` | ensureContentWrite, ensureStepUp | — | `{ enabled:boolean }` | reads: enableCollection | 3188 |
| 187 | GET | `/api/v1/admin/collections/:param/viewers` | ensureCollectionsRead | — | — | reads: listCollectionViewers | 3202 |
| 188 | POST | `/api/v1/admin/collections/:param/viewers` | ensureCollectionsWrite, ensureStepUp | — | `{ userIds:array }` | writes: setCollectionViewers; reads: max | 3213 |
| 189 | GET | `/api/v1/admin/collections/:param/progress` | ensureCollectionsRead | — | — | reads: collectionProgress | 3226 |
| 190 | GET | `/api/v1/admin/achievements` | ensureContentRead | — | — | reads: listAchievements | 3239 |
| 191 | POST | `/api/v1/admin/achievements/backfill` | ensureContentWrite, ensureStepUp | — | — | writes: backfillAchievements; reads: min, max, get | 3248 |
| 192 | POST | `/api/v1/admin/achievements` | ensureContentWrite, ensureStepUp | — | `{ scope:enum, key:string, name:string, description:string, criteria:record, reward?:record, visibility?:enum, artKey?:string, category?:string }` | writes: createAchievement; reads: default, max, min, unknown, optional | 3261 |
| 193 | GET | `/api/v1/admin/gifts` | ensureEconomyRead | — | — | reads: listAdminGiftCampaigns | 3285 |
| 194 | POST | `/api/v1/admin/gifts/preview` | ensureEconomyWrite | — | `giftSchema` | reads: previewAdminGift | 3294 |
| 195 | POST | `/api/v1/admin/gifts` | ensureEconomyWrite, ensureStepUp | — | `giftSchema` | writes: sendAdminGift | 3310 |
| 196 | POST | `/api/v1/admin/gifts/:param/retry` | ensureEconomyWrite, ensureStepUp | — | — | writes: processGiftCampaign | 3324 |
| 197 | GET | `/api/v1/platform/overview` | requireSuperAdmin | — | — | — | 3338 |
| 198 | GET | `/api/v1/platform/accounts` | requireSuperAdmin | — | — | — | 3390 |
| 199 | GET | `/api/v1/platform/people` | requireSuperAdmin | — | — | reads: listPlatformPeople, get | 3408 |
| 200 | GET | `/api/v1/platform/roles` | requireSuperAdmin | — | — | reads: listPlatformRoleAssignments | 3423 |
| 201 | POST | `/api/v1/platform/roles` | requireSuperAdmin, ensureStepUp | — | `{ userId:idSchema, role:enum, scopes?:boolean, reason:string }` | writes: assignPlatformRole; reads: optional, max, min | 3432 |
| 202 | POST | `/api/v1/platform/roles/:param/revoke` | requireSuperAdmin, ensureStepUp | — | `{ role:enum, reason:string }` | writes: revokePlatformRole; reads: max, min | 3456 |
| 203 | PATCH | `/api/v1/platform/installations/:param` | requireSuperAdmin, ensureStepUp | — | `{ channelAllowlist?:string, gameEnabled?:boolean, websiteEnabled?:boolean, apiEnabled?:boolean, publicCatalogueEnabled?:boolean, adminGuiEnabled?:boolean, active?:boolean }` | writes: replace, join; reads: optional, max, regex, push, stringify | 3475 |
| 204 | POST | `/api/v1/platform/bots/:param/status` | requireSuperAdmin, ensureStepUp | — | `{ status:enum }` | reads: run, bind, prepare, stringify | 3550 |
| 205 | GET | `/api/v1/platform/collections` | requireSuperAdmin | — | — | reads: filter, listCollections | 3592 |

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

All 399 browser, CLI and MCP paths resolve to a dispatcher or direct Astro route.

## OpenAPI reconciliation

All 70 documented operations resolve to a dispatcher or direct Astro route.

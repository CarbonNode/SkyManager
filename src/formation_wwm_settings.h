#pragma once
#include <cmath>
#include <string_view>

// Public 0.2.2 config contract, pinned in third_party/walk-with-me/README.md.
// Deliberately engine-independent: input validation and UI bounds share one table.
namespace FormationWwmSettings
{
    enum class Kind { toggle, number, integer };
    struct Field {
        const char* group;
        const char* key;
        const char* section;
        const char* iniKey;
        const char* label;
        Kind kind;
        double fallback, low, high, step;
    };
    inline constexpr Field Fields[] = {
        {"travel","enabled","General","bEnabled","Walk With Me",Kind::toggle,1,0,1,1},
        {"travel","autoDiscover","General","bAutoDiscover","Automatically enroll followers",Kind::toggle,0,0,1,1},
        {"travel","requireTeammate","General","bRequirePlayerTeammate","Require a recruited follower",Kind::toggle,1,0,1,1},
        {"travel","maxFollowers","General","iMaxFollowers","Companion limit",Kind::integer,10,1,10,1},
        {"travel","spacing","Movement","fSpacingScale","Formation spacing",Kind::number,1.02,.6,3,.05},
        {"travel","catchUpBonus","Movement","fCatchUpSpeedBonus","Catch-up speed bonus",Kind::number,150,0,250,5},
        {"travel","arrivalRadius","Movement","fArrivalRadius","Arrival distance",Kind::number,65,40,100,1},
        {"travel","individuality","Movement","fCompanionIndividuality","Individual movement",Kind::number,1,0,1,.05},
        {"travel","teleportCatchup","Movement","bTeleportCatchup","Recall distant companions",Kind::toggle,1,0,1,1},
        {"travel","teleportDistance","Movement","fTeleportDistance","Recall beyond this distance",Kind::number,4000,1500,15000,100},
        {"travel","forwardCollision","Movement","bForwardCollision","Avoid nearby obstacles",Kind::toggle,1,0,1,1},
        {"hands","handsEnabled","HandHolding","bEnabled","Hand-holding",Kind::toggle,0,0,1,1},
        {"hands","leadIn","HandHolding","fLeadInSeconds","Approach delay (seconds)",Kind::number,1,.5,10,.1},
        {"hands","connectDistance","HandHolding","fConnectDistance","Connect within",Kind::number,90,60,110,1},
        {"hands","handReleaseDistance","HandHolding","fReleaseDistance","Release beyond",Kind::number,120,70,160,1},
        {"hands","palmX","HandHolding","fPalmX","TETHER palm offset X",Kind::number,0,-15,15,.25},
        {"hands","palmY","HandHolding","fPalmY","TETHER palm offset Y",Kind::number,-2.35,-15,15,.25},
        {"hands","palmZ","HandHolding","fPalmZ","TETHER palm offset Z",Kind::number,5,-15,15,.25},
        {"hands","gripGap","HandHolding","fGripWristGap","TETHER wrist gap",Kind::number,45,8,45,1},
        {"rest","automaticRest","Sandbox","bAutomatic","Rest when you stop",Kind::toggle,1,0,1,1},
        {"rest","restRadius","Sandbox","fStartRadius","Starting rest radius",Kind::number,400,40,600,10},
        {"rest","maxRestRadius","Sandbox","fMaxRadius","Maximum rest radius",Kind::number,1600,40,1800,10},
        {"rest","resumeDistance","Sandbox","fResumeDistance","Resume travel after",Kind::number,508,100,1000,10},
        {"rest","fullRestAfter","Sandbox","fFullSandboxAfter","Settle after (seconds)",Kind::number,10,0,180,1},
        {"rest","groundSitting","Sandbox","bGroundSitting","Sit on the ground",Kind::toggle,1,0,1,1},
        {"rest","meals","Sandbox","bMeals","Eat together",Kind::toggle,1,0,1,1},
        {"rest","reading","Sandbox","bReading","Read while resting",Kind::toggle,1,0,1,1},
        {"rest","stretching","Sandbox","bStretching","Stretch while resting",Kind::toggle,1,0,1,1},
        {"rest","areaActivities","Sandbox","bAreaActivities","Activities suited to the location",Kind::toggle,1,0,1,1},
        {"rest","socialIdles","Sandbox","bSocialIdles","Companion conversations",Kind::toggle,1,0,1,1},
        {"rest","walkingBanter","PartyLife","bWalkingBanter","Conversations while walking",Kind::toggle,1,0,1,1},
        {"rest","conversationAwareness","PartyLife","bConversationAwareness","Give conversations room",Kind::toggle,1,0,1,1},
        {"rest","personalities","PartyLife","bPersonalities","Individual personalities",Kind::toggle,1,0,1,1},
        {"rest","lookouts","PartyLife","bLookouts","Keep watch while resting",Kind::toggle,1,0,1,1},
        {"rest","extraRestPoses","Sandbox","bExtraRestPoses","Extra rest poses",Kind::toggle,0,0,1,1},
        {"scout","lootEnabled","Loot","bEnabled","Scout for loot",Kind::toggle,1,0,1,1},
        {"scout","containers","Loot","bContainers","Search containers",Kind::toggle,1,0,1,1},
        {"scout","bodies","Loot","bBodies","Search bodies",Kind::toggle,1,0,1,1},
        {"scout","looseItems","Loot","bLooseItems","Find valuable loose items",Kind::toggle,1,0,1,1},
        {"scout","lootIcons","Loot","bIcons","Show discovery icons",Kind::toggle,1,0,1,1},
        {"scout","inhabitedInteriors","Loot","bInhabitedInteriors","Scout in homes and settlements",Kind::toggle,0,0,1,1},
        {"scout","searchRadius","Loot","fSearchRadius","Search radius",Kind::number,1000,300,2500,50},
        {"scout","valuableGold","Loot","iValuableGold","Valuable item threshold (gold)",Kind::integer,1000,1,100000,1},
        {"scout","searchSeconds","Loot","fSearchSeconds","Search time (seconds)",Kind::number,12,5,30,1},
        {"scout","areaDistance","Loot","fAreaDistance","Distance before another search",Kind::number,2000,800,6000,50},
        {"safety","combat","Safety","bReleaseInCombat","Release in combat",Kind::toggle,1,0,1,1},
        {"safety","sneaking","Safety","bReleaseWhenSneaking","Release while sneaking",Kind::toggle,1,0,1,1},
        {"safety","weaponDrawn","Safety","bReleaseWhenWeaponDrawn","Release with weapons drawn",Kind::toggle,1,0,1,1},
        {"safety","controlsDisabled","Safety","bReleaseWhenControlsDisabled","Release during scenes",Kind::toggle,1,0,1,1},
        {"safety","requireTravelPackage","Safety","bRequireTravelPackage","Respect non-travel AI packages",Kind::toggle,1,0,1,1},
        {"safety","indoors","Safety","bDisableIndoors","Disable formations indoors",Kind::toggle,0,0,1,1},
        {"safety","releaseDistance","Safety","fReleaseDistance","Release beyond this distance",Kind::number,2500,500,10000,50},
        {"safety","enforceNff","Compatibility","bEnforceNFF","Allow travel control with NFF",Kind::toggle,1,0,1,1},
        {"safety","enforceCustom","Compatibility","bEnforceCustomFollowers","Allow travel control with custom followers",Kind::toggle,1,0,1,1},
        {"display","showHud","Interface","bShowOrderHUD","Show current order",Kind::toggle,1,0,1,1},
        {"display","hudPanel","Interface","bHUDPanel","Order panel background",Kind::toggle,1,0,1,1},
        {"display","hudScale","Interface","fHUDScale","Order emblem size",Kind::number,.97,.55,1.3,.01},
        {"display","hudVertical","Interface","fHUDVertical","Order emblem vertical position",Kind::number,.44,.1,.85,.01},
        {"display","restDialogueIcons","Interface","bRestDialogueIcons","Show conversation icons",Kind::toggle,1,0,1,1},
        {"display","animateChatIcons","Interface","bAnimateChatIcons","Animate conversation icons",Kind::toggle,1,0,1,1},
    };
    inline const Field* Find(std::string_view key) {
        for (const auto& field : Fields) if (key == field.key) return &field;
        return nullptr;
    }
    inline bool ValidNumber(const Field& field, double value) {
        return std::isfinite(value) && value >= field.low && value <= field.high &&
            (field.kind != Kind::integer || std::floor(value) == value);
    }
}

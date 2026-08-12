#include "Member.hpp"

#include "Utility/LogInfo.hpp"
#include "Utility/String.hpp"
#include "Utility/TESForm.hpp"

namespace organizer
{

	Member::Member(RE::TESForm* form, const std::string& name)
		: name(name), original_name(form ? form->GetName() : ""), tracked(false), form(form)
	{
		if(form)
		{
			if(const auto refr = form->As<RE::TESObjectREFR>())
			{
				if(const auto base = refr->GetBaseObject())
					base_form_string = utility::tesform::FormToString(base);
			}
		}
	}

	void Member::ApplyChanges() const
	{
		ApplyName();
	}

	void Member::SetOverrideName(const std::string& new_name)
	{
		name = new_name;
		ApplyName();
	}

	std::string Member::GetName() const
	{
		if(form == nullptr)
		{
			logger::warn("Member {} has no form.", original_name);
			if(!name.empty())
				return name;
			if(!original_name.empty())
				return original_name;
			return "[unresolved]";
		}

		if(const auto actor = form->As<RE::Actor>())
			return actor->GetDisplayFullName();

		return form->GetName();
	}
	void to_json(nlohmann::json& j, const Member& s)
	{
		logger::info("Member {} org: {} des: {} tracked: {}", s.name, s.original_name, s.description, s.tracked);
		std::string form_string = utility::tesform::FormToString(s.form);
		if(form_string.empty())
			form_string = s.base_form_string;
		j = json{ { "Name", s.name },
				  { "OriginalName", s.original_name },
				  { "Description", s.description },
				  { "Tracked", s.tracked },
				  { "Form", form_string },
				  { "BaseForm", s.base_form_string } };

		// NPC fields (Hotkey Deck). Emitted ONLY when non-empty: a roster that has
		// never used the feature keeps byte-for-byte the shape it has today, so we
		// don't churn 70 members x 5 rotating backups to write `"Fields": {}`.
		if(!s.fields.empty())
			j["Fields"] = s.fields;
	}

	void from_json(const nlohmann::json& j, Member& s)
	{
		s.name = j.value("Name", "");
		s.name = utility::str::trim(s.name);

		s.original_name = j.value("OriginalName", "");

		s.description = j.value("Description", "");
		s.description = utility::str::trim(s.description);

		s.tracked = j.value("Tracked", false);

		s.base_form_string = j.value("BaseForm", "");

		std::string value = j.value("Form", "");
		s.form = utility::tesform::FindForm<RE::TESForm>(value);

		if(s.form == nullptr && !s.base_form_string.empty())
		{
			s.form = utility::tesform::FindForm<RE::TESForm>(s.base_form_string);
			if(s.form)
				logger::info("REFR '{}' not found, fell back to base '{}'.", value, s.base_form_string);
		}

		if(s.form == nullptr)
		{
			logger::warn("Failed to find form (REFR='{}', base='{}'). Keeping entry for next session.", value, s.base_form_string);
		}
		else if(s.original_name.empty())
		{
			s.original_name = s.form->GetName();
		}

		if(s.base_form_string.empty() && s.form)
		{
			if(const auto refr = s.form->As<RE::TESObjectREFR>())
			{
				if(const auto base = refr->GetBaseObject())
					s.base_form_string = utility::tesform::FormToString(base);
			}
		}

		// NPC fields. Read by hand rather than with j.value("Fields", map{}):
		// value() THROWS if the key exists but holds a non-object, and this runs
		// inside LoadSettings — one hand-edited JSON would take the whole roster
		// down. Absent, null, wrong type and non-string values all read as "no
		// fields"; anything usable is kept, including keys this build has never
		// heard of (that is what lets the deck add a field without a DLL rebuild).
		s.fields.clear();
		if(const auto it = j.find("Fields"); it != j.end() && it->is_object())
		{
			for(const auto& [key, value2] : it->items())
			{
				if(!value2.is_string())
					continue;
				// trim() binds an lvalue (same shape as every call above).
				auto text = value2.get<std::string>();
				text = utility::str::trim(text);
				if(!text.empty())
					s.fields.emplace(key, std::move(text));
			}
		}
	}

	void Member::ApplyName() const
	{
		if(form == nullptr)
			return;

		if(form->As<RE::TESForm>() != nullptr)
		{
			if(name.empty())
			{
				if(original_name.empty())
					logger::warn("Form {} has no original name.", form->GetName());
				else
				{
					DebugMessage("Changed form {} name to original name {}.", form->GetName(), original_name);
					form->As<RE::TESFullName>()->fullName = original_name;
				}
			}
			else
			{
				DebugMessage("Changed form {} name to {}.", form->GetName(), name);
				if(const auto actor = form->As<RE::Actor>())
				{
					actor->SetDisplayName(name, true);
				}
				else
					form->As<RE::TESFullName>()->fullName = name;
			}
		}
	}
}

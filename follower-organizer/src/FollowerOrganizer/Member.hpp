#pragma once

#include <map>

namespace organizer
{

	class Member
	{
		public:
			Member() = default;
			explicit Member(RE::TESForm* form, const std::string& name = "");

			void ApplyChanges() const;

			void SetOverrideName(const std::string& name);
			[[nodiscard]] std::string GetName() const;

			std::string name;
			std::string original_name;
			std::string description;
			bool tracked = false;
			RE::TESForm* form = nullptr;
			std::string base_form_string;

			/**
			 * Free-form per-member facts, owned by the Hotkey Deck's Followers tab
			 * and the Deck Portal: "relationship" -> "wife", "home" -> "Riverwood
			 * Keep", and whatever the deck's field spec grows into next. Persisted
			 * under "Fields"; absent means empty. FO's own UI never shows it.
			 *
			 * Deliberately a map and not four named members: the deck can add a
			 * field by editing one JS array, with no DLL rebuild and no migration,
			 * and a key this build has never heard of still round-trips.
			 */
			std::map<std::string, std::string> fields;

			bool operator==(const Member& other) const
			{
				return form == other.form;
			}

			friend void to_json(nlohmann::json& j, const Member& s);
			friend void from_json(const nlohmann::json& j, Member& s);

		private:
			void ApplyName() const;
	};
}

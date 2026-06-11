document.addEventListener('DOMContentLoaded', function() {
    console.log("DOMContentLoaded event fired");

// Initialize various arrays and variables
    // Data structure to store selected skill and EG values for each skill row
    let selectedSkills = [];
    let selectedEGs = [];
    let noCreditFlag = false;

    // Map for skill values
    const skillValues = {
        'A': 0.1,
        'B': 0.2,
        'C': 0.3,
        'D': 0.4,
        'E': 0.5,
        'F': 0.6,
        'G': 0.7,
        'H': 0.8,
        'I': 0.9,
        'J': 1.0
    };

    // Get the relevant page elements
    const skillRowsContainer = document.getElementById('skill-rows');
    const rulesetDropdown = document.getElementById('ruleset');
    const apparatusDropdown = document.getElementById('apparatus');
    const bonusOptionsContainer = document.getElementById('bonus-options');    
    const deductionsContainer = document.getElementById('neutral-deductions-options');

    // Initialize the Bonus Section based on the default selection
    updateBonusOptions();

    // Initialize the Deductions Section based on the default selection
    updateDeductionOptions();

    // Initialize the skill rows based on the default ruleset
    updateSkillRows();

// Create event listeners for all the various inputs so that things can be triggered when they're pressed
    // Event delegation for skill buttons
    skillRowsContainer.addEventListener('click', function(event) {
        if (event.target.tagName === 'BUTTON' && event.target.closest('.buttons')) {
            const skillRow = event.target.parentElement.parentElement.dataset.row;
            const skillValue = event.target.dataset.value;
            selectSkill(skillRow, skillValue, event.target);
        }
    });

    // Event delegation for EG buttons
    skillRowsContainer.addEventListener('click', function(event) {
        if (event.target.tagName === 'BUTTON' && event.target.closest('.eg-buttons')) {
            const skillRow = event.target.parentElement.parentElement.dataset.row;
            const egValue = event.target.dataset.eg;
            selectEG(skillRow, egValue, event.target);
        }
    });

    // Add event listener for the "Hide Neutral Deductions" checkbox
    document.getElementById('hide-neutral-deductions-checkbox').addEventListener('change', function() {
        const deductionsSection = document.getElementById('neutral-deductions-section');
        const minusSymbol = document.querySelector('.minus-symbol');
        const neutralDeductionsDisplay = document.getElementById('neutral-deductions-display')

        if (this.checked) {
            deductionsSection.style.display = 'none';  // Hide the deductions section
            // neutralDeductionsDisplay.style.display = 'none';  // Hide the deductions part in the SV breakdown
            // minusSymbol.style.display = 'none';
        } else {
            deductionsSection.style.display = 'block';  // Show the deductions section
            // neutralDeductionsDisplay.style.display = 'block';  // Show the deductions part in the SV breakdown
            // minusSymbol.style.display = 'block';
        }

        // Recalculate Start Value when toggling the checkbox
        updateStartValue();
    });


// Attach event listeners to all the elements that we want to trigger an update of the SV
    // Attach event listeners to the ruleset and apparatus dropdowns to update skill rows when the ruleset changes
    rulesetDropdown.addEventListener('change', updateSkillRows);
    apparatusDropdown.addEventListener('change', updateSkillRows);

    // Update the Start Value when the Rule Set or Apparatus is changed 
    rulesetDropdown.addEventListener('change', updateStartValue);
    apparatusDropdown.addEventListener('change', updateStartValue);

    // Attach event listeners for changes in ruleset or apparatus to update the bonus options
    rulesetDropdown.addEventListener('change', updateBonusOptions);
    apparatusDropdown.addEventListener('change', updateBonusOptions);

    // Attach event listeners for changes in ruleset or apparatus to update the deduction options
    rulesetDropdown.addEventListener('change', updateDeductionOptions);
    apparatusDropdown.addEventListener('change', updateDeductionOptions);

    // Attach the reset function to the reset button
        document.getElementById('reset-button').addEventListener('click', resetRoutine);

// Create various helper functions to use in calculations/functions
    // Misc. Helper Functions
        // Helper function to reset the routine when the reset button is pushed
        function resetRoutine() {
            // Clear skill and EG selections
            selectedSkills = Array(skillRowsContainer.children.length).fill(null);
            selectedEGs = Array(skillRowsContainer.children.length).fill(null);

            // Clear the visual selections (remove 'selected' class from buttons)
            document.querySelectorAll('.buttons button, .eg-buttons button').forEach(button => {
                button.classList.remove('selected'); // Assuming 'selected' is the class that highlights selections
            });

            // Reset the skill rows to the current ruleset (this will keep the number of rows correct)
            updateSkillRows();

            // Reset any other relevant values
            updateStartValue(); // Recalculate and reset the start value display
        }

        // Helper function to ensure only one checkbox in a pair is selected
        function enforceSingleCheckbox(id1, id2) {
            console.log(`Enforcing a single checkbox is checked among ${id1} and ${id2}`)
            document.querySelectorAll(`input[id="${id1}"]`).forEach(checkbox1 => {
                checkbox1.addEventListener('change', function() {
                    console.log(`Checkbox "${id1}" changed`)
                    if (this.checked) {
                        document.querySelectorAll(`input[id="${id2}"]`).forEach(checkbox2 => {
                            checkbox2.checked = false;
                        });
                    }
                });
            });

            document.querySelectorAll(`input[id="${id2}"]`).forEach(checkbox2 => {
                checkbox2.addEventListener('change', function() {
                    console.log(`Checkbox "${id2}" changed`)
                    if (this.checked) {
                        document.querySelectorAll(`input[id="${id1}"]`).forEach(checkbox1 => {
                            checkbox1.checked = false;
                        });
                    }
                });
            });
        }

        // Helper function to create a dropdown
        function createDropdown(label, options, id, container) {
            const dropdownContainer = document.createElement('div');
            const dropdownLabel = document.createElement('label');
            dropdownLabel.classList.add('mr-2');  // Adds margin-right of about 16px
            dropdownLabel.textContent = label;
            dropdownContainer.appendChild(dropdownLabel);

            const select = document.createElement('select');
            select.id = id;  // Assign the ID attribute
            options.forEach(option => {
                const opt = document.createElement('option');
                opt.value = option;
                opt.textContent = option;
                select.appendChild(opt);
            });
            dropdownContainer.appendChild(select);
            if (container === 'bonus') {
                bonusOptionsContainer.appendChild(dropdownContainer);
            } else if (container === 'deductions') {
                deductionsContainer.appendChild(dropdownContainer)
            }
        }

        // Helper function to create a checkbox
        function createCheckbox(label, id, container) {
            const checkboxContainer = document.createElement('div');
            checkboxContainer.classList.add('form-check');  // Add Bootstrap class for styling

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = id;  // Assign the ID attribute
            checkbox.classList.add('form-check-input');  // Add Bootstrap class for checkbox

            const checkboxLabel = document.createElement('label');
            checkboxLabel.textContent = label;
            checkboxLabel.classList.add('form-check-label');  // Add Bootstrap class for label

            checkboxContainer.appendChild(checkbox);
            checkboxContainer.appendChild(checkboxLabel);

            if (container === 'bonus') {
                bonusOptionsContainer.appendChild(checkboxContainer);
            } else if (container === 'deductions') {
                deductionsContainer.appendChild(checkboxContainer);
            }
        }

        // Helper function to create a vault value dropdown for VT
        function createVaultDropdown() {
            // Clear existing skill rows
            skillRowsContainer.innerHTML = '';

            // Create a container for the vault dropdown
            const vaultRow = document.createElement('div');
            vaultRow.classList.add('vault-row', 'd-flex', 'justify-content-center', 'align-items-center', 'mb-3');

            const label = document.createElement('label');
            label.textContent = 'Vault Value:';
            label.classList.add('mr-2');  // Bootstrap class to add some margin-right for spacing
            vaultRow.appendChild(label);

            // Create the dropdown for vault values (1.2 to 5.6 in 0.2 increments)
            const vaultDropdown = document.createElement('select');
            vaultDropdown.id = 'vault-value-dropdown';
            vaultDropdown.classList.add('form-control', 'w-auto');  // Bootstrap classes for styling the dropdown

            for (let value = 1.2; value <= 5.6; value += 0.2) {
                const option = document.createElement('option');
                option.value = value.toFixed(1);  // Round to 1 decimal place
                option.textContent = value.toFixed(1);
                vaultDropdown.appendChild(option);
            }

            vaultRow.appendChild(vaultDropdown);
            skillRowsContainer.appendChild(vaultRow);

            // Add event listener to update start value when vault value changes
            vaultDropdown.addEventListener('change', updateStartValue);
        }
        
    // Skill Value Helper Functions
        // Helper function to create skill rows based on the selected level
        function createSkillRows(numRows) {
            // Save existing skill and EG selections
            const currentSkills = [...selectedSkills];
            const currentEGs = [...selectedEGs];

            // Clear existing rows
            skillRowsContainer.innerHTML = '';

            // Initialize the selectedSkills and selectedEGs arrays based on the number of rows
            selectedSkills = Array(numRows).fill(null);
            selectedEGs = Array(numRows).fill(null);

            for (let i = 1; i <= numRows; i++) {
                const skillRow = document.createElement('div');
                skillRow.classList.add('skill-row');
                skillRow.setAttribute('data-row', i);

                const label = document.createElement('label');
                label.textContent = `Skill #${i}:`;
                skillRow.appendChild(label);

                const buttonsDiv = document.createElement('div');
                buttonsDiv.classList.add('buttons');
                
                // Create skill buttons (A to J)
                ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].forEach(skill => {
                    const button = document.createElement('button');
                    button.textContent = skill;
                    button.setAttribute('data-value', skill);

                    // Pre-select the existing skill if it exists for this row
                    if (currentSkills[i - 1] === skill) {
                        button.classList.add('selected'); // Apply selected state visually
                        selectedSkills[i - 1] = skill;   // Update the new array
                    }

                    buttonsDiv.appendChild(button);
                });
                skillRow.appendChild(buttonsDiv);

                // Add a separator
                const separator = document.createElement('div');
                separator.classList.add('separator');
                skillRow.appendChild(separator);

                const egButtonsDiv = document.createElement('div');
                egButtonsDiv.classList.add('eg-buttons');

                // Create EG buttons (I to IV)
                ['I', 'II', 'III', 'IV'].forEach(eg => {
                    const button = document.createElement('button');
                    button.textContent = `EG ${eg}`;
                    button.setAttribute('data-eg', eg);

                    // Pre-select the existing EG if it exists for this row
                    if (currentEGs[i - 1] === eg) {
                        button.classList.add('selected'); // Apply selected state visually
                        selectedEGs[i - 1] = eg;         // Update the new array
                    }

                    egButtonsDiv.appendChild(button);
                });
                skillRow.appendChild(egButtonsDiv);

                // Append the skill row to the container
                skillRowsContainer.appendChild(skillRow);
            }
        }

        // Helper function to update the number of skill rows based on the ruleset and apparatus
        function updateSkillRows() {
            const selectedRuleset = rulesetDropdown.value;
            const selectedApparatus = apparatusDropdown.value;

            // Reset the No Credit Flag
            noCreditFlag = false;

            // If VT is selected, show the vault value dropdown instead of skill rows
            if (selectedApparatus === 'VT') {
                createVaultDropdown();
            } else {
                // Normal behavior for other apparatus
                if (selectedRuleset === 'NAIGC Developmental') {
                    createSkillRows(6);  // Create 6 rows for Developmental
                } else {
                    createSkillRows(8);  // Create 8 rows for other levels
                }
            }

            updateStartValue();  // Update the start value calculation
        }


        // Helper function to define what happens when a skill value button is pressed
        function selectSkill(skillRow, skillValue, button) {
            // If the button is already selected, unselect it
            if (button.classList.contains('selected')) {
                // Remove the selected class and reset red color if applicable
                button.classList.remove('selected', 'excluded-skill');
                
                // Clear the selected skill value for this row
                selectedSkills[skillRow - 1] = null;
                
                console.log(`Unselected Skill on row ${skillRow}`);
            } else {
                // Update selected skill for the row
                selectedSkills[skillRow - 1] = skillValue;
                
                // Update the button styles to highlight the selected one
                const buttons = document.querySelectorAll(`.skill-row:nth-child(${skillRow}) .buttons button`);
                buttons.forEach(btn => btn.classList.remove('selected', 'excluded-skill'));
                button.classList.add('selected');
                
                console.log(`Selected Skill: ${skillValue} on row ${skillRow}`);
            }

            // Recalculate the Start Value
            updateStartValue();
        }

        function addWarningText(row, text) {
            let warningSpan = document.querySelector(`.skill-row[data-row="${row}"] .warning-text`);
            if (!warningSpan) {
                warningSpan = document.createElement('span');
                warningSpan.classList.add('warning-text');
                warningSpan.style.color = 'red';
                warningSpan.textContent = text;
                document.querySelector(`.skill-row[data-row="${row}"]`).appendChild(warningSpan);
            }
        }

        function removeWarningText(row) {
            const warningSpan = document.querySelector(`.skill-row[data-row="${row}"] .warning-text`);
            if (warningSpan) {
                warningSpan.remove();
            }
        }
        
    // EG Helper Functions
        // Helper function to update the EG Button Colors to Highlight the last skill for each EG that contributes a bonus equal to the highest bonus for that EG
        function updateEGButtonColors(egiRows, egiiRows, egiiiRows, egivRows) {
            // Get the green color dynamically from a selected skill button
            const selectedSkillButton = document.querySelector('.buttons button[style*="background-color"]');
            const selectedGreenColor = selectedSkillButton ? window.getComputedStyle(selectedSkillButton).backgroundColor : '#28a745';

            // Loop over all EG buttons and reset their state to dark grey (if they are pressed)
            document.querySelectorAll('.eg-buttons button').forEach(button => {
                const skillRow = button.parentElement.parentElement.dataset.row;
                const eg = button.dataset.eg;

                // Reset pressed buttons to dark grey
                if (selectedEGs[skillRow - 1] === eg) {
                    button.style.backgroundColor = 'darkgrey';
                } else {
                    // Unpressed buttons and any previously excluded (red) buttons reset to default
                    button.classList.remove('excluded-skill');
                    button.style.backgroundColor = '';
                }
            });

            // Highlight all EG I buttons that contribute to the bonus
            egiRows.forEach(row => {
                const egButton = document.querySelector(`.skill-row[data-row="${row}"] .eg-buttons button[data-eg="I"]`);
                if (egButton) egButton.style.backgroundColor = selectedGreenColor;
            });

            // Highlight all EG II buttons that contribute to the bonus
            egiiRows.forEach(row => {
                const egButton = document.querySelector(`.skill-row[data-row="${row}"] .eg-buttons button[data-eg="II"]`);
                if (egButton) egButton.style.backgroundColor = selectedGreenColor;
            });

            // Highlight all EG III buttons that contribute to the bonus
            egiiiRows.forEach(row => {
                const egButton = document.querySelector(`.skill-row[data-row="${row}"] .eg-buttons button[data-eg="III"]`);
                if (egButton) egButton.style.backgroundColor = selectedGreenColor;
            });

            // Highlight all EG IV buttons that contribute to the bonus
            egivRows.forEach(row => {
                const egButton = document.querySelector(`.skill-row[data-row="${row}"] .eg-buttons button[data-eg="IV"]`);
                if (egButton) egButton.style.backgroundColor = selectedGreenColor;
            });
        }

        // Helper function to define what happens when an EG button is pressed
        function selectEG(skillRow, egValue, button) {
            // If the button is already selected, unselect it
            if (button.classList.contains('selected')) {
                // Remove the selected class and reset red color if applicable
                button.classList.remove('selected', 'excluded-skill');
                
                // Clear the selected EG value for this row
                selectedEGs[skillRow - 1] = null;
                
                console.log(`Unselected EG on row ${skillRow}`);
            } else {
                // Update selected EG for the row
                selectedEGs[skillRow - 1] = egValue;
                
                // Find the specific EG buttons in this skillRow using the data-row attribute
                const egButtons = document.querySelectorAll(`.skill-row[data-row="${skillRow}"] .eg-buttons button`);
                
                // Remove selected class from all EG buttons in this row and reset red color
                egButtons.forEach(btn => btn.classList.remove('selected', 'excluded-skill'));
                
                // Add the selected class to the clicked button
                button.classList.add('selected');
                
                console.log(`Selected EG: ${egValue} on row ${skillRow}`);
            }

            // Recalculate the Start Value
            updateStartValue();
        }

        // EG Bonus Calculation Functions for each level
            function calculateDevelopmentalEGBonus(apparatus) {
                let egiBonus = 0, egiiBonus = 0, egiiiBonus = 0, egivBonus = 0;
                let egiRows = [], egiiRows = [], egiiiRows = [], egivRows = [];  // Track all rows for the best bonus in each EG

                selectedEGs.forEach((eg, index) => {
                    const skill = selectedSkills[index];
                    const skillRow = index + 1;

                    // Only apply EG bonus if skill and EG are selected
                    if (eg !== null && skill !== null) {
                        if (eg === 'I') {
                            egiBonus = 0.5;
                            egiRows.push(skillRow);
                        }
                        if (eg === 'II') {
                            egiiBonus = 0.5;
                            egiiRows.push(skillRow);
                        }
                        if (eg === 'III') {
                            egiiiBonus = 0.5;
                            egiiiRows.push(skillRow);
                        }
                        if (eg === 'IV') {
                            egivBonus = 0.5;
                            egivRows.push(skillRow);
                        }
                    }
                });

                // Cap the EG bonus at 1.5
                const totalEGBonus = Math.min((egiBonus + egiiBonus + egiiiBonus + egivBonus), 1.5);
                console.log(`Total Developmental EG Bonus: ${totalEGBonus}`);

                // Update the button colors
                updateEGButtonColors(egiRows, egiiRows, egiiiRows, egivRows);

                return totalEGBonus;
            }

            function calculateIntermediateEGBonus(apparatus) {
                let egiBonus = 0, egiiBonus = 0, egiiiBonus = 0, egivBonus = 0;
                let egiRows = [], egiiRows = [], egiiiRows = [], egivRows = [];  // Track all rows for the best bonus in each EG

                selectedEGs.forEach((eg, index) => {
                    const skill = selectedSkills[index];
                    const skillRow = index + 1;

                    // EG I: Award 0.5 if any skill exists in EG I
                    if (eg === 'I' && skill !== null) {
                        egiBonus = 0.5;
                        egiRows.push(skillRow);  // Track rows for EG I
                    }

                    // EG II: Check for the best bonus (A = 0.3, B or higher = 0.5)
                    if (eg === 'II') {
                        if (skill === 'A' && egiiBonus < 0.3) {
                            egiiBonus = 0.3;
                            egiiRows = [skillRow];  // Reset for the lower bonus
                        } else if (skill === 'A' && egiiBonus === 0.3) {
                            egiiRows.push(skillRow);  // Add rows for 0.3 bonus
                        } else if (skill !== null && egiiBonus < 0.5) {
                            egiiBonus = 0.5;
                            egiiRows = [skillRow];  // Reset for the higher bonus
                        } else if (skill !== null && egiiBonus === 0.5) {
                            egiiRows.push(skillRow);  // Add rows for 0.5 bonus
                        }
                    }

                    // EG III: Same logic as EG II (A = 0.3, B or higher = 0.5)
                    if (eg === 'III') {
                        if (skill === 'A' && egiiiBonus < 0.3) {
                            egiiiBonus = 0.3;
                            egiiiRows = [skillRow];
                        } else if (skill === 'A' && egiiiBonus === 0.3) {
                            egiiiRows.push(skillRow);
                        } else if (skill !== null && egiiiBonus < 0.5) {
                            egiiiBonus = 0.5;
                            egiiiRows = [skillRow];
                        } else if (skill !== null && egiiiBonus === 0.5) {
                            egiiiRows.push(skillRow);
                        }
                    }

                    // EG IV: Special case for FX, normal for other apparatus
                    if (eg === 'IV') {
                        if (apparatus === 'FX') {
                            if (skill === 'A' && egivBonus < 0.3) {
                                egivBonus = 0.3;
                                egivRows = [skillRow];
                            } else if (skill === 'A' && egivBonus === 0.3) {
                                egivRows.push(skillRow);
                            } else if (skill !== null && egivBonus < 0.5) {
                                egivBonus = 0.5;
                                egivRows = [skillRow];
                            } else if (skill !== null && egivBonus === 0.5) {
                                egivRows.push(skillRow);
                            }
                        } else {
                            const skillBonus = skillValues[skill] || 0;
                            if (egivBonus < skillBonus) {
                                egivBonus = skillBonus;
                                egivRows = [skillRow];
                            } else if (egivBonus === skillBonus) {
                                egivRows.push(skillRow);
                            }
                        }
                    }
                });

                // Update the colors based on which rows have the best bonus for each EG
                updateEGButtonColors(egiRows, egiiRows, egiiiRows, egivRows);

                // Return total EG bonus
                const totalEGBonus = egiBonus + egiiBonus + egiiiBonus + egivBonus;
                console.log(`Total Intermediate EG Bonus: ${totalEGBonus}`);
                return totalEGBonus;
            }

            function calculateAdvancedEGBonus(apparatus) {
                let egiBonus = 0, egiiBonus = 0, egiiiBonus = 0, egivBonus = 0;
                let egiRows = [], egiiRows = [], egiiiRows = [], egivRows = [];  // Track all rows for the best bonus in each EG

                selectedEGs.forEach((eg, index) => {
                    const skill = selectedSkills[index];
                    const skillRow = index + 1;

                    // EG I: Award 0.5 if any skill exists in EG I
                    if (eg === 'I' && skill !== null) {
                        egiBonus = 0.5;
                        egiRows.push(skillRow);  // Track rows for EG I
                    }

                    // EG II: (A/B = 0.3, C = 0.4, D+ = 0.5)
                    if (eg === 'II') {
                        if ((skill === 'A' || skill === 'B') && egiiBonus < 0.3) {
                            egiiBonus = 0.3;
                            egiiRows = [skillRow];
                        } else if ((skill === 'A' || skill === 'B') && egiiBonus === 0.3) {
                            egiiRows.push(skillRow);
                        } else if (skill === 'C' && egiiBonus < 0.4) {
                            egiiBonus = 0.4;
                            egiiRows = [skillRow];
                        } else if (skill === 'C' && egiiBonus === 0.4) {
                            egiiRows.push(skillRow);
                        } else if (skill !== null && skill > 'C' && egiiBonus < 0.5) {
                            egiiBonus = 0.5;
                            egiiRows = [skillRow];
                        } else if (skill !== null && skill > 'C' && egiiBonus === 0.5) {
                            egiiRows.push(skillRow);
                        }
                    }

                    // EG III: Same logic as EG II (A/B = 0.3, C = 0.4, D+ = 0.5)
                    if (eg === 'III') {
                        if ((skill === 'A' || skill === 'B') && egiiiBonus < 0.3) {
                            egiiiBonus = 0.3;
                            egiiiRows = [skillRow];
                        } else if ((skill === 'A' || skill === 'B') && egiiiBonus === 0.3) {
                            egiiiRows.push(skillRow);
                        } else if (skill === 'C' && egiiiBonus < 0.4) {
                            egiiiBonus = 0.4;
                            egiiiRows = [skillRow];
                        } else if (skill === 'C' && egiiiBonus === 0.4) {
                            egiiiRows.push(skillRow);
                        } else if (skill !== null && skill > 'C' && egiiiBonus < 0.5) {
                            egiiiBonus = 0.5;
                            egiiiRows = [skillRow];
                        } else if (skill !== null && skill > 'C' && egiiiBonus === 0.5) {
                            egiiiRows.push(skillRow);
                        }
                    }

                    // EG IV: Special handling for FX, normal for other apparatus
                    if (eg === 'IV') {
                        if (apparatus === 'FX') {
                            if (skill === 'A' || skill === 'B') {
                                egivBonus = Math.max(egivBonus, 0.3);
                                egivRows.push(skillRow);
                            } else if (skill === 'C') {
                                egivBonus = Math.max(egivBonus, 0.4);
                                egivRows.push(skillRow);
                            } else if (skill > 'C') {
                                egivBonus = Math.max(egivBonus, 0.5);
                                egivRows.push(skillRow);
                            }
                        } else {
                            const skillBonus = skillValues[skill] || 0;
                            if (egivBonus < skillBonus) {
                                egivBonus = skillBonus;
                                egivRows = [skillRow];
                            } else if (egivBonus === skillBonus) {
                                egivRows.push(skillRow);
                            }
                        }
                    }
                });

                // Update the button colors
                updateEGButtonColors(egiRows, egiiRows, egiiiRows, egivRows);

                const totalEGBonus = egiBonus + egiiBonus + egiiiBonus + egivBonus;
                console.log(`Total Advanced EG Bonus: ${totalEGBonus}`);
                return totalEGBonus;
            }

            function calculateFIGEGBonus(apparatus) {
                let egiBonus = 0, egiiBonus = 0, egiiiBonus = 0, egivBonus = 0;
                let egiRows = [], egiiRows = [], egiiiRows = [], egivRows = []; // Track all rows contributing to the best bonus in each EG

                selectedEGs.forEach((eg, index) => {
                    const skill = selectedSkills[index];
                    const skillRow = index + 1;

                    // EG I: Award 0.5 if any skill exists in EG I
                    if (eg === 'I' && skill !== null) {
                        egiBonus = 0.5;  // Always award 0.5 for EG I
                        egiRows.push(skillRow);  // Track the row contributing to EG I
                    }

                    // EG II: D or higher = 0.5, otherwise 0.3 if it exists
                    if (eg === 'II') {
                        if (skill > 'C' && egiiBonus < 0.5) {
                            egiiBonus = 0.5;
                            egiiRows = [skillRow]; // Reset the rows with the new higher bonus
                        } else if (skill > 'C' && egiiBonus === 0.5) {
                            egiiRows.push(skillRow); // Add additional rows with the same bonus
                        } else if (skill !== null && egiiBonus < 0.3) {
                            egiiBonus = 0.3;
                            egiiRows = [skillRow]; // Reset for the lower bonus
                        } else if (skill !== null && egiiBonus === 0.3) {
                            egiiRows.push(skillRow); // Add rows for the 0.3 bonus
                        }
                    }

                    // EG III: D or higher = 0.5, otherwise 0.3 if it exists
                    if (eg === 'III') {
                        if (skill > 'C' && egiiiBonus < 0.5) {
                            egiiiBonus = 0.5;
                            egiiiRows = [skillRow];
                        } else if (skill > 'C' && egiiiBonus === 0.5) {
                            egiiiRows.push(skillRow);
                        } else if (skill !== null && egiiiBonus < 0.3) {
                            egiiiBonus = 0.3;
                            egiiiRows = [skillRow];
                        } else if (skill !== null && egiiiBonus === 0.3) {
                            egiiiRows.push(skillRow);
                        }
                    }

                    // EG IV: Special handling for FX, normal for other apparatus
                    if (eg === 'IV') {
                        if (apparatus === 'FX') {
                            if (skill > 'C' && egivBonus < 0.5) {
                                egivBonus = 0.5;
                                egivRows = [skillRow];
                            } else if (skill > 'C' && egivBonus === 0.5) {
                                egivRows.push(skillRow);
                            } else if (skill !== null && egivBonus < 0.3) {
                                egivBonus = 0.3;
                                egivRows = [skillRow];
                            } else if (skill !== null && egivBonus === 0.3) {
                                egivRows.push(skillRow);
                            }
                        } else {
                            const skillBonus = skillValues[skill] || 0;
                            if (egivBonus < skillBonus) {
                                egivBonus = skillBonus;
                                egivRows = [skillRow];
                            } else if (egivBonus === skillBonus) {
                                egivRows.push(skillRow);
                            }
                        }
                    }
                });

                // Update the button colors to reflect all rows contributing to each EG
                updateEGButtonColors(egiRows, egiiRows, egiiiRows, egivRows);

                const totalEGBonus = egiBonus + egiiBonus + egiiiBonus + egivBonus;
                console.log(`Total FIG EG Bonus: ${totalEGBonus}`);
                return totalEGBonus;
            }

    // Other Bonus Helper Functions
        // Helper function to call to update the start value when any bonus option changes
        function bonusOptionChangeListener(event) {
            updateStartValue();
        }

        // Helper function to dynamically update Bonus Section
        function updateBonusOptions() {
            const selectedRuleset = rulesetDropdown.value;
            const selectedApparatus = apparatusDropdown.value;

            // Clear previous bonus options
            bonusOptionsContainer.innerHTML = '';

            // **Remove existing event listeners from current dropdowns and checkboxes**
            const bonusElements = bonusOptionsContainer.querySelectorAll('input, select');
            bonusElements.forEach(element => {
                element.removeEventListener('change', bonusOptionChangeListener);
                console.log("Removed all the bonus option listeners")
            });

            // Logic to create bonus options based on ruleset and apparatus
            if (selectedRuleset === 'NAIGC Developmental') {
                if (selectedApparatus === 'FX') {
                    createDropdown('≥D + B/C = +0.1 ', [0, 1, 2, 3, 4, 5],'0.1-dropdown', 'bonus');
                    createDropdown('≥D + ≥D = +0.2 ', [0, 1, 2, 3, 4, 5],'0.2-dropdown', 'bonus');
                    createCheckbox('Stick Bonus +0.1','0.1-checkbox', 'bonus');
                } else if (selectedApparatus === 'PH') {
                    createDropdown('Pommel Horse Mushroom Bonus ', [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],'mushroom-dropdown', 'bonus');
                } else if (selectedApparatus === 'SR') {
                    createCheckbox('Strength skill ≥C +0.1','0.1-checkbox', 'bonus');
                    createCheckbox('Stick Bonus +0.1','0.1-checkbox', 'bonus');
                } else if (selectedApparatus === 'VT') {
                    createCheckbox('Stick Bonus +0.1','0.1-checkbox', 'bonus');
                } else if (selectedApparatus === 'PB') {
                    createCheckbox('Stick Bonus +0.1','0.1-checkbox', 'bonus');
                } else if (selectedApparatus === 'HB') {
                    createDropdown('C + C Connection (any combination of flight and in bar) +0.1 each ', [0,1,2,3,4,5],'0.1-dropdown', 'bonus');
                    createCheckbox('Stick Bonus +0.1','0.1-checkbox', 'bonus')
                }
            }

            if (selectedRuleset === 'NAIGC Intermediate') {
                if (selectedApparatus === 'FX') {
                    createDropdown('≥D + B/C = +0.1 ', [0, 1, 2, 3, 4, 5],'0.1-dropdown', 'bonus');
                    createDropdown('≥D + ≥D = +0.2 ', [0, 1, 2, 3, 4, 5],'0.2-dropdown', 'bonus');
                    createCheckbox('Stick Bonus +0.1','0.1-checkbox', 'bonus');
                } //No PH Bonus at this level
                else if (selectedApparatus === 'SR') { 
                    createCheckbox('Strength skill ≥C +0.1','0.1-checkbox', 'bonus');
                    createCheckbox('Stick Bonus +0.1','0.1-checkbox', 'bonus');
                } else if (selectedApparatus === 'VT') {
                    createCheckbox('Stick Bonus +0.1 (Non-Flipping Vault)','0.1-checkbox', 'bonus');
                    createCheckbox('Stick Bonus +0.2 (Flipping Vault)','0.2-checkbox', 'bonus');
                    // Ensure only one stick bonus can be checked
                    enforceSingleCheckbox('0.1-checkbox','0.2-checkbox', 'bonus');
                } else if (selectedApparatus === 'PB') {
                    createCheckbox('Stick Bonus +0.1','0.1-checkbox', 'bonus');
                } else if (selectedApparatus === 'HB') {
                    createDropdown('C + C Connection (any combination of flight and in bar) +0.1 each ', [0,1,2,3,4,5],'0.1-dropdown', 'bonus')
                    createCheckbox('Stick Bonus +0.1','0.1-checkbox', 'bonus');
                }
            }

            if (selectedRuleset === 'NAIGC Advanced') {
                if (selectedApparatus === 'FX') {
                    createDropdown('≥D + B/C = +0.1', [0, 1, 2, 3, 4, 5],'0.1-dropdown', 'bonus');
                    createDropdown('≥D + ≥D = +0.2', [0, 1, 2, 3, 4, 5],'0.2-dropdown', 'bonus');
                    createCheckbox('Double Flipping Dismount +0.1', '0.1-checkbox', 'bonus')
                    createCheckbox('Stick Bonus +0.1 (B)', 'stick-bonus-B', 'bonus');
                    createCheckbox('Stick Bonus +0.2 (≥C)', 'stick-bonus-≥C', 'bonus');
                    // Ensure only one stick bonus can be checked
                    enforceSingleCheckbox('stick-bonus-B','stick-bonus-≥C', 'bonus');
                } //No PH Bonus at this level
                else if (selectedApparatus === 'SR') { 
                    createCheckbox('Strength skill ≥C +0.1', '0.1-checkbox', 'bonus');
                    createCheckbox('Stick Bonus +0.1 (B)', 'stick-bonus-B', 'bonus');
                    createCheckbox('Stick Bonus +0.2 (≥C)', 'stick-bonus-≥C', 'bonus');
                    // Ensure only one stick bonus can be checked
                    enforceSingleCheckbox('stick-bonus-B','stick-bonus-≥C', 'bonus');
                } else if (selectedApparatus === 'VT') {
                    createCheckbox('Stick Bonus +0.2 (Flipping Vault)', '0.2-checkbox', 'bonus');
                } else if (selectedApparatus === 'PB') {
                    createCheckbox('Stick Bonus +0.1 (B)', 'stick-bonus-B', 'bonus');
                    createCheckbox('Stick Bonus +0.2 (≥C)', 'stick-bonus-≥C', 'bonus');
                    // Ensure only one stick bonus can be checked
                    enforceSingleCheckbox('stick-bonus-B','stick-bonus-≥C', 'bonus');
                } else if (selectedApparatus === 'HB') {
                    createDropdown('C + C Connection (any combination of flight and in bar) +0.1 each ', [0,1,2,3,4,5],'0.1-dropdown', 'bonus');
                    createCheckbox('Stick Bonus +0.1 (B)', 'stick-bonus-B', 'bonus');
                    createCheckbox('Stick Bonus +0.2 (≥C)', 'stick-bonus-≥C', 'bonus');
                    // Ensure only one stick bonus can be checked
                    enforceSingleCheckbox('stick-bonus-B','stick-bonus-≥C', 'bonus');
                }
            }

            if (selectedRuleset === 'FIG') {
                if (selectedApparatus === 'FX') {
                    createDropdown('≥D + B/C = +0.1', [0, 1, 2, 3, 4, 5],'0.1-dropdown', 'bonus');
                    createDropdown('≥D + ≥D = +0.2', [0, 1, 2, 3, 4, 5],'0.2-dropdown', 'bonus');
                    createCheckbox('Stick Bonus (≥C) +0.1', '0.1-checkbox', 'bonus');
                } //No PH Bonus at this level
                else if (selectedApparatus === 'SR') {
                    createCheckbox('Stick Bonus (≥C) +0.1', '0.1-checkbox', 'bonus');
                } else if (selectedApparatus === 'VT') {
                    createCheckbox('Stick Bonus (Flipping Vault) +0.1', '0.1-checkbox', 'bonus');
                } else if (selectedApparatus === 'PB') {
                    createCheckbox('Stick Bonus (≥C) +0.1', '0.1-checkbox', 'bonus');
                } else if (selectedApparatus === 'HB') {
                    createDropdown('C/D flight + D flight connection +0.1 each ', [0,1,2,3,4,5],'0.1-dropdown', 'bonus');
                    createDropdown('≥D flight + ≥E flight connection +0.2 each ', [0,1,2,3,4,5],'0.2-dropdown', 'bonus');
                    createDropdown('D flight + ≥D EG I or EG III connection +0.1 each ', [0,1,2,3,4,5],'0.1-dropdown', 'bonus');
                    createDropdown('≥E flight + ≥D EG I or EG III connection +0.2 each ', [0,1,2,3,4,5],'0.2-dropdown', 'bonus');
                    createCheckbox('Stick Bonus (≥C) +0.1', '0.1-checkbox', 'bonus');
                }
            }

            // **Reattach event listeners to the new dropdowns and checkboxes**
            const newBonusElements = document.querySelectorAll('input, select');
            newBonusElements.forEach(element => {
                element.addEventListener('change', bonusOptionChangeListener);
            });

            // Update the Start Value since we're clearing all the bonuses
            updateStartValue();
        }

        // Function to Calculate other Bonus (stick, connection, etc.)
        function calculateBonusValue() {
            console.log("Updating Bonus Value")
            let bonusValue = 0;

            // Array of checkbox bonus types with corresponding bonus values
            const checkboxBonusTypes = [
                { id: '0.1-checkbox', value: 0.1 },
                { id: '0.2-checkbox', value: 0.2 },
                { id: 'stick-bonus-B', value: 0.1 },
                { id: 'stick-bonus-≥C', value: 0.2 }
            ];

            // Loop through each checkbox bonus type
            checkboxBonusTypes.forEach(bonusType => {
                bonusOptionsContainer.querySelectorAll(`input[id="${bonusType.id}"]`).forEach(checkbox => {
                    if (checkbox.checked) {
                        bonusValue += bonusType.value;
                    }
                });
            });

            // Array of dropdown bonus types with multipliers
            const dropdownBonusTypes = [
                { id: '0.1-dropdown', multiplier: 0.1 },
                { id: '0.2-dropdown', multiplier: 0.2 },
                { id: 'mushroom-dropdown', multiplier: 1 }  // Mushroom dropdown adds the value directly
            ];

            // Loop through dropdown bonuses and multiply the selected value by the appropriate multiplier
            dropdownBonusTypes.forEach(bonusType => {
                bonusOptionsContainer.querySelectorAll(`select[id="${bonusType.id}"]`).forEach(dropdown => {
                    bonusValue += parseFloat(dropdown.value) * bonusType.multiplier;
                });
            });

            return bonusValue;
        }

    // Neutral Deduction Helper Functions
        // Helper function to call to update the start value when any neutral deduction option changes
        function deductionOptionChangeListener(event) {
            updateStartValue();
        }

        // Automatically calculate short exercise deduction based on selected ruleset
        function calculateShortExerciseDeduction(ruleset) {
            let deduction = 0;
            let selectedSkillsCount = selectedSkills.filter(skill => skill !== null).length;

            if (ruleset === 'FIG') {
                // FIG rules: -2.0 plus an additional -1.0 for each missing skill
                if (selectedSkillsCount < 6) {
                    deduction = 2 + (6 - selectedSkillsCount);
                } else if (selectedSkillsCount === 0) {
                    deduction = 10;
                }
            } else if (ruleset === 'NAIGC Intermediate' || ruleset === 'NAIGC Advanced') {
                // Intermediate, Advanced: -1.0 for each skill row with no value, if less than 6
                if (selectedSkillsCount < 6) {
                    deduction = (6 - selectedSkillsCount);
                }
            } else {
                // Developmental: -0.5 for each skill row with no value, if less than 6
                if (selectedSkillsCount < 6) {
                    deduction = 0.5 * (6 - selectedSkillsCount);
                }
            }

            return deduction;
        }

        // Helper function to dynamically update Neutral Deductions Section
        function updateDeductionOptions() {
            console.log("Updating Deduction Options");
            const selectedRuleset = rulesetDropdown.value;
            const selectedApparatus = apparatusDropdown.value;

            // Clear previous deduction options
            deductionsContainer.innerHTML = '';

            // **Remove existing event listeners from current dropdowns and checkboxes**
            const deductionElements = deductionsContainer.querySelectorAll('input, select');
            deductionElements.forEach(element => {
                element.removeEventListener('change', deductionOptionChangeListener);
                console.log("Removed all the deduction option listeners");
            });

            // Logic to create deduction options based on ruleset and apparatus
            if (selectedApparatus === 'FX') {
                createDropdown('Exercise longer than 70 sec. ', ['None','≤ 2 sec. : -0.1', '>2 - 5 sec. : -0.3', '> 5 sec. : -0.5'], 'fx-time-deduction', 'deductions');
                createDropdown('Landing or touching with one foot or one hand outside the floor area. -0.1 ', [0,1,2,3,4,5], '0.1-dropdown', 'deductions');
                createDropdown('Touching with feet, hands, or any other part of the body outside the floor area. -0.3 ', [0,1,2,3,4,5], '0.3-dropdown', 'deductions');
                createCheckbox('No pass to/from each corner. -0.3', '0.3-checkbox', 'deductions');
                createCheckbox('Using the same diagonal more than 2 times in a row. -0.3', '0.3-checkbox', 'deductions');
                if (selectedRuleset === 'NAIGC Advanced') {
                    createCheckbox('No multiple salto element (doesn\'t have to be the dismount) -0.3', '0.3-checkbox', 'deductions');
                } else if (selectedRuleset === 'FIG') {
                    createCheckbox('No multiple salto element (dismount for seniors) -0.3', '0.3-checkbox', 'deductions');
                    createCheckbox('No balance on one leg -0.3', '0.3-checkbox', 'deductions');                    
                }
            } else if (selectedApparatus === 'SR') {
                if (selectedRuleset === 'NAIGC Advanced' || selectedRuleset === 'FIG') {
                    createCheckbox('No swing to handstand -0.3', '0.3-checkbox', 'deductions');
                }
            } else if (selectedApparatus === 'VT') {
                createCheckbox('Landing or touching with one foot or hand outside the landing area -0.1', '0.1-checkbox', 'deductions');
                createCheckbox('Touching with feet, hands, foot and hand or with any other part of the body outside of the landing area -0.3', '0.3-checkbox', 'deductions');
                createCheckbox('Touching with feet, hands, foot and hand or with any other part of the body outside of the landing area -0.5', '0.5-checkbox', 'deductions');
                createCheckbox('Failure to use vault board safety collar for round off entry vaults - No Credit', 'no-credit-checkbox', 'deductions');
            }

            // **Reattach event listeners to the new dropdowns and checkboxes**
            const newDeductionElements = document.querySelectorAll('input, select');
            newDeductionElements.forEach(element => {
                element.addEventListener('change', deductionOptionChangeListener);
            });

            // Update the Start Value since we're clearing all the deductions
            updateStartValue();
        }

        // Function to calculate total neutral deductions
        function calculateNeutralDeductions() {
            // Check if the "Hide Neutral Deductions" checkbox is checked
            const hideNeutralDeductions = document.getElementById('hide-neutral-deductions-checkbox').checked;

            if (hideNeutralDeductions) {
                return 0;  // Return 0 if deductions are hidden
            }

            let deductionsValue = 0;

            // Array of checkbox deduction types with corresponding bonus values
            const checkboxDeductionTypes = [
                { id: '0.1-checkbox', value: 0.1 },
                { id: '0.3-checkbox', value: 0.3 },
                { id: '0.5-checkbox', value: 0.5 },
                { id: 'no-credit-checkbox', value: 0.0 },
            ];

            // Loop through each checkbox bonus type in the deductionsContainer
            checkboxDeductionTypes.forEach(deductionType => {
                deductionsContainer.querySelectorAll(`input[id="${deductionType.id}"]`).forEach(checkbox => {
                    if (checkbox.checked) {
                        deductionsValue += deductionType.value;
                    }

                    // If a no-credit checkbox is checked, then set the noCreditFlag to true so that when calculating the SV it can be set to 0.0
                    if (deductionType.id === 'no-credit-checkbox' && checkbox.checked) {
                        noCreditFlag = true;
                    }
                });
            });

            // Array of dropdown bonus types with multipliers
            const dropdownDeductionTypes = [
                { id: '0.1-dropdown', multiplier: 0.1 },
                { id: '0.3-dropdown', multiplier: 0.3 },
                { id: 'fx-time-deduction', multiplier: 0.2 }  // the number in the dropdown will be multiplied by 0.2 and then subtract 0.1
            ];

            // Loop through dropdown deductions and multiply the selected value by the appropriate multiplier
            dropdownDeductionTypes.forEach(deductionType => {
                deductionsContainer.querySelectorAll(`select[id="${deductionType.id}"]`).forEach(dropdown => {
                    if (deductionType.id === 'fx-time-deduction') {
                        if (dropdown.value === '≤ 2 sec. : -0.1') {
                            deductionsValue += 0.1;
                        } else if (dropdown.value === '>2 - 5 sec. : -0.3') {
                            deductionsValue += 0.3;
                        } else if (dropdown.value === '> 5 sec. : -0.5') {
                            deductionsValue += 0.5;
                        }
                    } else {
                        deductionsValue += parseFloat(dropdown.value) * deductionType.multiplier;
                    }
                });
            });

            return deductionsValue;
        }

    // Start Value Functions
        function updateStartValue() {
            const ruleset = document.getElementById('ruleset').value;
            const apparatus = document.getElementById('apparatus').value;

            let totalSkillValue = 0;
            let egBonus = 0;
            let otherBonus = calculateBonusValue();
            let neutralDeductions = calculateNeutralDeductions();
            let shortExerciseDeduction = calculateShortExerciseDeduction(ruleset);
            neutralDeductions += shortExerciseDeduction;
            let cappedStartValue = null;
            let warnings = []; // Store all warnings

            const egSkills = { 'I': [], 'II': [], 'III': [], 'IV': [] };
            let egIIICounter = 0; // To track the count of EGII and EGIII skills
            let foundHigherEGISkill = false;
            let egIIWarningShown = false; // Flag to track if EGII/III warning is already shown
            let fourPerEGWarningShown = false; // Flag to track if four per EG warning is already shown

            if (apparatus === 'VT') {
                // Handle VT separately
                const vaultDropdown = document.getElementById('vault-value-dropdown');
                const vaultValue = parseFloat(vaultDropdown.value);
                totalSkillValue = vaultValue;
            } else {
                // First sweep: Apply EGII/III Rule ONLY for Still Rings
                if (apparatus === 'SR') {
                    selectedSkills.forEach((skill, index) => {
                        if (skill) {
                            const eg = selectedEGs[index];
                            const skillValue = skillValues[skill];
                            const button = document.querySelector(`.skill-row[data-row="${index + 1}"] .buttons button[data-value="${skill}"]`);
                            const egButton = eg ? document.querySelector(`.skill-row[data-row="${index + 1}"] .eg-buttons button[data-eg="${eg}"]`) : null;

                            // EGII/EGIII Rule logic
                            if ((eg === 'II' || eg === 'III') && !foundHigherEGISkill) {
                                egIIICounter++;
                                if (egIIICounter > 3) {
                                    // Exclude this skill due to EGII/EGIII rule
                                    button.classList.add('excluded-skill');
                                    if (egButton) egButton.classList.add('excluded-skill'); // Add null check for EG button

                                    if (!egIIWarningShown) {
                                        warnings.push('>3 EGII and/or EGIII skills without a ≥B EGI skill');
                                        egIIWarningShown = true; // Show warning only once
                                    }
                                    return;
                                }
                            } else if (eg === 'I' && skill >= 'B') {
                                // Reset the counter once a ≥B EGI skill is encountered
                                foundHigherEGISkill = true;
                                egIIICounter = 0;
                            }

                            // Include the skill for the 4 per EG rule if it passed the EGII/EGIII rule
                            if (eg) egSkills[eg]?.push({ skill, index, value: skillValue });
                            button.classList.remove('excluded-skill');
                            if (egButton) egButton.classList.remove('excluded-skill'); // Null check for EG button
                            totalSkillValue += skillValue;
                        }
                    });
                } else {
                    // If not Still Rings, we directly accumulate the skills for the 4 per EG rule
                    selectedSkills.forEach((skill, index) => {
                        if (skill) {
                            const eg = selectedEGs[index];
                            const skillValue = skillValues[skill];
                            const button = document.querySelector(`.skill-row[data-row="${index + 1}"] .buttons button[data-value="${skill}"]`);
                            const egButton = eg ? document.querySelector(`.skill-row[data-row="${index + 1}"] .eg-buttons button[data-eg="${eg}"]`) : null;

                            if (eg) egSkills[eg]?.push({ skill, index, value: skillValue });
                            button.classList.remove('excluded-skill');
                            if (egButton) egButton.classList.remove('excluded-skill'); // Null check for EG button
                            totalSkillValue += skillValue;
                        }
                    });
                }

                // Second sweep: Apply 4 Skills per EG Rule for all apparatus
                Object.keys(egSkills).forEach(eg => {
                    if (egSkills[eg].length > 4) {
                        egSkills[eg].sort((a, b) => b.value - a.value); // Sort in descending value
                        egSkills[eg].forEach((skillData, i) => {
                            const button = document.querySelector(`.skill-row[data-row="${skillData.index + 1}"] .buttons button[data-value="${skillData.skill}"]`);
                            const egButton = document.querySelector(`.skill-row[data-row="${skillData.index + 1}"] .eg-buttons button[data-eg="${eg}"]`);

                            if (i >= 4) {
                                // Exclude skills over the limit of 4
                                button.classList.add('excluded-skill');
                                egButton?.classList.add('excluded-skill'); // Add null check for EG button

                                if (!fourPerEGWarningShown) {
                                    warnings.push('4 Elements/EG Maximum Exceeded');
                                    fourPerEGWarningShown = true; // Show warning only once
                                }
                            } else {
                                totalSkillValue += skillData.value;
                                button.classList.remove('excluded-skill');
                                if (egButton) egButton.classList.remove('excluded-skill');
                            }
                        });
                    }
                });

                // Calculate EG bonus as usual
                switch (ruleset) {
                    case 'NAIGC Developmental':
                        egBonus = calculateDevelopmentalEGBonus(apparatus);
                        break;
                    case 'NAIGC Intermediate':
                        egBonus = calculateIntermediateEGBonus(apparatus);
                        break;
                    case 'NAIGC Advanced':
                        egBonus = calculateAdvancedEGBonus(apparatus);
                        break;
                    case 'FIG':
                        egBonus = calculateFIGEGBonus(apparatus);
                        break;
                }
            }

            const executionValue = 10.0;
            let rawStartValue = executionValue + totalSkillValue + egBonus + otherBonus;

            if (ruleset === 'NAIGC Developmental' && rawStartValue > 12.7) {
                cappedStartValue = 12.7;
            } else if (ruleset === 'NAIGC Intermediate' && rawStartValue > 13.2) {
                cappedStartValue = 13.2;
            }

            let finalStartValue = cappedStartValue !== null ? cappedStartValue - neutralDeductions : rawStartValue - neutralDeductions;

            document.getElementById('skills-value').textContent = totalSkillValue.toFixed(1);
            document.getElementById('eg-bonus-value').textContent = egBonus.toFixed(1);
            document.getElementById('other-bonus-value').textContent = otherBonus.toFixed(1);
            document.getElementById('neutral-deductions-value').textContent = neutralDeductions.toFixed(1);
            document.getElementById('start-value-total').textContent = finalStartValue.toFixed(1);

            const capNotification = document.getElementById('cap-notification');
            if (cappedStartValue !== null) {
                capNotification.textContent = `Start Value Cap implemented, SV reduced to ${cappedStartValue.toFixed(1)} from ${rawStartValue.toFixed(1)}`;
                capNotification.style.display = 'block';
            } else {
                capNotification.style.display = 'none';
            }

            const egWarningMessage = document.getElementById('eg-warning-message');
            if (warnings.length > 0) {
                egWarningMessage.innerHTML = warnings.join('<br>'); // Display warnings with line breaks
                egWarningMessage.style.display = 'block';
            } else {
                egWarningMessage.style.display = 'none';
            }
        }

});
